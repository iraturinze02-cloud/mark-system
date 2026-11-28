
import {
    connectDB,
    authenticateRole,
    json
} from "../../_utils.js";

/* =====================================================
   FILA GRADES SYSTEM
   BULK STUDENT REGISTRATION API

   POST /api/students/bulk

   Supports:
   - School Admin
   - Director of Studies (DOS)
   - Excel bulk registration
   - Automatic student-code generation
   - Academic year and term validation
   - Subclass assignment
   - Transaction-based insertion

   IMPORTANT:
   - All rows are validated before insertion.
   - If any row is invalid, nothing is inserted.
   - Existing individual student registration is untouched.
===================================================== */


/* =====================================================
   CONFIGURATION
===================================================== */

const MAX_STUDENTS_PER_UPLOAD = 500;


/* =====================================================
   GENERATE STUDENT CODE
===================================================== */

function generateStudentCode() {
    return `STU-${Date.now()}-${crypto.randomUUID()
        .slice(0, 8)
        .toUpperCase()}`;
}


/* =====================================================
   NORMALIZE TEXT
===================================================== */

function normalizeText(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value).trim();
}


/* =====================================================
   NORMALIZE GENDER
===================================================== */

function normalizeGender(value) {
    const gender = normalizeText(value).toLowerCase();

    if (gender === "male" || gender === "m") {
        return "Male";
    }

    if (gender === "female" || gender === "f") {
        return "Female";
    }

    return null;
}


/* =====================================================
   VALIDATE DATE

   Expected format: YYYY-MM-DD
===================================================== */

function normalizeDate(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const date = String(value).trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return undefined;
    }

    const [year, month, day] = date.split("-").map(Number);

    const parsed = new Date(Date.UTC(year, month - 1, day));

    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        return undefined;
    }

    return date;
}


/* =====================================================
   FORMAT VALIDATION ERRORS
===================================================== */

function formatValidationMessage(errors) {
    const displayedErrors = errors.slice(0, 20);

    let message = "Please correct the following Excel rows:\n";

    message += displayedErrors
        .map(error => `Row ${error.row}: ${error.message}`)
        .join("\n");

    if (errors.length > 20) {
        message += `\nAnd ${errors.length - 20} more error(s).`;
    }

    return message;
}


/* =====================================================
   POST: BULK REGISTER STUDENTS
===================================================== */

export async function onRequestPost(context) {

    /* -----------------------------------------------
       AUTHENTICATION
    ----------------------------------------------- */

    const auth = await authenticateRole(context, [
        "school_admin",
        "dos"
    ]);

    if (auth.error) {
        return auth.error;
    }

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not linked to a school."
        }, 403);
    }


    let client;
    let transactionStarted = false;


    try {

        /* -------------------------------------------
           READ REQUEST BODY
        ------------------------------------------- */

        let body;

        try {
            body = await context.request.json();
        } catch {
            return json({
                success: false,
                message: "Invalid request data."
            }, 400);
        }


        const academicYearId = Number(body.academic_year_id);
        const termId = Number(body.term_id);
        const students = body.students;


        /* -------------------------------------------
           BASIC VALIDATION
        ------------------------------------------- */

        if (
            !Number.isInteger(academicYearId) ||
            academicYearId <= 0
        ) {
            return json({
                success: false,
                message: "Please select a valid academic year."
            }, 400);
        }


        if (
            !Number.isInteger(termId) ||
            termId <= 0
        ) {
            return json({
                success: false,
                message: "Please select a valid academic term."
            }, 400);
        }


        if (!Array.isArray(students) || students.length === 0) {
            return json({
                success: false,
                message: "The uploaded Excel file contains no student records."
            }, 400);
        }


        if (students.length > MAX_STUDENTS_PER_UPLOAD) {
            return json({
                success: false,
                message: `You can upload a maximum of ${MAX_STUDENTS_PER_UPLOAD} students at once.`
            }, 400);
        }


        /* -------------------------------------------
           CONNECT DATABASE
        ------------------------------------------- */

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;


        /* -------------------------------------------
           VALIDATE ACADEMIC YEAR AND TERM

           Both must belong to the authenticated
           school and the term must belong to the
           selected academic year.
        ------------------------------------------- */

        const periodResult = await client.query(
            `
            SELECT
                ay.id AS academic_year_id,
                ay.start_date AS year_start_date,
                ay.end_date AS year_end_date,

                t.id AS term_id,
                t.start_date AS term_start_date,
                t.end_date AS term_end_date

            FROM academic_years ay

            INNER JOIN terms t
                ON t.academic_year_id = ay.id
                AND t.school_id = ay.school_id

            WHERE ay.id = $1
              AND t.id = $2
              AND ay.school_id = $3
              AND t.school_id = $3

            LIMIT 1
            `,
            [
                academicYearId,
                termId,
                auth.schoolId
            ]
        );


        if (periodResult.rows.length === 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "The selected academic year or term does not belong to your school."
            }, 400);
        }


        const period = periodResult.rows[0];


        /* -------------------------------------------
           GET SCHOOL CLASSES

           Only classes belonging to this school
           are available for student registration.
        ------------------------------------------- */

        const classesResult = await client.query(
            `
            SELECT
                c.id,
                c.class_name

            FROM classes c

            INNER JOIN school_levels sl
                ON sl.level_id = c.level_id

            WHERE sl.school_id = $1
            `,
            [auth.schoolId]
        );


        const classMap = new Map();

        for (const item of classesResult.rows) {

            const key = normalizeText(item.class_name).toLowerCase();

            if (key && !classMap.has(key)) {
                classMap.set(key, item);
            }
        }


        /* -------------------------------------------
           GET ACTIVE SUBCLASSES FOR THIS YEAR
        ------------------------------------------- */

        const subclassesResult = await client.query(
            `
            SELECT
                id,
                class_id,
                subclass_name,
                status

            FROM school_class_subclasses

            WHERE school_id = $1
              AND academic_year_id = $2
              AND LOWER(status) = 'active'
            `,
            [
                auth.schoolId,
                academicYearId
            ]
        );


        const subclassMap = new Map();

        for (const item of subclassesResult.rows) {

            const key =
                `${item.class_id}:${normalizeText(item.subclass_name).toLowerCase()}`;

            if (!subclassMap.has(key)) {
                subclassMap.set(key, item);
            }
        }


        /* -------------------------------------------
           VALIDATE ALL EXCEL ROWS

           No student is inserted during this stage.
        ------------------------------------------- */

        const errors = [];
        const validatedStudents = [];


        for (let index = 0; index < students.length; index++) {

            const student = students[index];

            const excelRow = Number(student?.excel_row) || index + 2;

            const fullName = normalizeText(student?.full_name);
            const gender = normalizeGender(student?.gender);
            const className = normalizeText(student?.class_name);
            const subclassName = normalizeText(student?.subclass_name);

            const dateOfBirth = normalizeDate(student?.date_of_birth);
            const admissionDate = normalizeDate(student?.admission_date);


            /* ---------------------------------------
               FULL NAME
            --------------------------------------- */

            if (!fullName) {

                errors.push({
                    row: excelRow,
                    message: "Student full name is required."
                });

                continue;
            }


            if (fullName.length > 200) {

                errors.push({
                    row: excelRow,
                    message: "Student full name must not exceed 200 characters."
                });

                continue;
            }


            /* ---------------------------------------
               GENDER
            --------------------------------------- */

            if (!gender) {

                errors.push({
                    row: excelRow,
                    message: "Gender must be Male or Female."
                });

                continue;
            }


            /* ---------------------------------------
               CLASS
            --------------------------------------- */

            if (!className) {

                errors.push({
                    row: excelRow,
                    message: "Class is required."
                });

                continue;
            }


            const classRecord = classMap.get(className.toLowerCase());


            if (!classRecord) {

                errors.push({
                    row: excelRow,
                    message: `Class "${className}" does not exist in your school.`
                });

                continue;
            }


            /* ---------------------------------------
               SUBCLASS
            --------------------------------------- */

            let subclassId = null;


            if (subclassName) {

                const subclassKey =
                    `${classRecord.id}:${subclassName.toLowerCase()}`;

                const subclassRecord = subclassMap.get(subclassKey);


                if (!subclassRecord) {

                    errors.push({
                        row: excelRow,
                        message: `Subclass "${subclassName}" does not exist or is inactive in class ${className}.`
                    });

                    continue;
                }


                subclassId = subclassRecord.id;
            }


            /* ---------------------------------------
               DATE OF BIRTH
            --------------------------------------- */

            if (dateOfBirth === undefined) {

                errors.push({
                    row: excelRow,
                    message: "Date of Birth must use YYYY-MM-DD format and be a valid date."
                });

                continue;
            }


            /* ---------------------------------------
               ADMISSION DATE
            --------------------------------------- */

            if (admissionDate === undefined) {

                errors.push({
                    row: excelRow,
                    message: "Admission Date must use YYYY-MM-DD format and be a valid date."
                });

                continue;
            }


            /* ---------------------------------------
               SAVE VALIDATED STUDENT
            --------------------------------------- */

            validatedStudents.push({

                excel_row: excelRow,

                full_name: fullName,

                gender,

                class_id: classRecord.id,

                class_name: classRecord.class_name,

                subclass_id: subclassId,

                subclass_name: subclassName || null,

                date_of_birth: dateOfBirth,

                admission_date: admissionDate

            });

        }


        /* -------------------------------------------
           STOP IF ANY VALIDATION ERROR EXISTS
        ------------------------------------------- */

        if (errors.length > 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,

                message: formatValidationMessage(errors),

                errors,

                errorCount: errors.length,

                importedCount: 0

            }, 400);
        }


        /* -------------------------------------------
           INSERT STUDENTS AND ENROLLMENTS

           Both records are inserted together.

           If one insertion fails, the entire
           transaction is rolled back.
        ------------------------------------------- */

        const insertedStudents = [];


        for (const student of validatedStudents) {

            const studentCode = generateStudentCode();


            /* ---------------------------------------
               INSERT STUDENT
            --------------------------------------- */

            const studentResult = await client.query(
                `
                INSERT INTO students (
                    school_id,
                    class_id,
                    student_code,
                    full_name,
                    gender,
                    date_of_birth,
                    admission_date
                )

                VALUES ($1, $2, $3, $4, $5, $6, $7)

                RETURNING
                    id,
                    student_code,
                    full_name,
                    class_id
                `,
                [
                    auth.schoolId,
                    student.class_id,
                    studentCode,
                    student.full_name,
                    student.gender,
                    student.date_of_birth,
                    student.admission_date
                ]
            );


            const savedStudent = studentResult.rows[0];


            /* ---------------------------------------
               INSERT STUDENT ENROLLMENT
            --------------------------------------- */

            const enrollmentResult = await client.query(
                `
                INSERT INTO student_enrollments (
                    student_id,
                    school_id,
                    class_id,
                    academic_year_id,
                    term_id,
                    subclass_id,
                    start_date,
                    end_date,
                    status
                )

                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, 'active'
                )

                RETURNING id
                `,
                [
                    savedStudent.id,
                    auth.schoolId,
                    student.class_id,
                    academicYearId,
                    termId,
                    student.subclass_id,
                    period.term_start_date,
                    period.term_end_date
                ]
            );


            insertedStudents.push({

                id: savedStudent.id,

                student_code: savedStudent.student_code,

                full_name: savedStudent.full_name,

                class_id: savedStudent.class_id,

                subclass_id: student.subclass_id,

                enrollment_id: enrollmentResult.rows[0].id,

                excel_row: student.excel_row

            });

        }


        /* -------------------------------------------
           COMMIT TRANSACTION
        ------------------------------------------- */

        await client.query("COMMIT");
        transactionStarted = false;


        /* -------------------------------------------
           SUCCESS RESPONSE
        ------------------------------------------- */

        return json({

            success: true,

            message: `Successfully registered ${insertedStudents.length} students.`,

            importedCount: insertedStudents.length,

            errorCount: 0,

            students: insertedStudents

        }, 201);


    } catch (error) {

        /* -------------------------------------------
           ROLLBACK ON FAILURE
        ------------------------------------------- */

        if (client && transactionStarted) {

            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error(
                    "Bulk student registration rollback error:",
                    rollbackError
                );
            }
        }


        console.error(
            "Bulk student registration error:",
            error
        );


        return json({

            success: false,

            message: "Bulk student registration failed. No students were registered. Please try again or contact support.",

            importedCount: 0

        }, 500);


    } finally {

        if (client) {

            try {
                await client.end();
            } catch (closeError) {
                console.error(
                    "Bulk student database connection close error:",
                    closeError
                );
            }
        }

    }

}
