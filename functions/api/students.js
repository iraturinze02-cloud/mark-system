
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   GET STUDENTS
   SCHOOL ADMIN + DOS

   FILTER BY SELECTED ACADEMIC YEAR AND TERM
   INCLUDE SUBCLASS INFORMATION
===================================================== */

export async function onRequestGet(context) {
    const auth = await authenticateRole(
        context,
        ["school_admin", "dos"]
    );

    if (auth.error) return auth.error;

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not linked to a school."
        }, 403);
    }

    const url = new URL(context.request.url);

    const academicYearId = Number(
        url.searchParams.get("academic_year_id")
    );

    const termId = Number(
        url.searchParams.get("term_id")
    );

    let client;

    try {
        client = await connectDB(context);

        let period;

        if (
            Number.isSafeInteger(academicYearId) &&
            academicYearId > 0 &&
            Number.isSafeInteger(termId) &&
            termId > 0
        ) {
            const periodResult = await client.query(
                `SELECT
                    ay.id AS academic_year_id,
                    ay.year_name,
                    ay.start_date AS year_start,
                    ay.end_date AS year_end,
                    t.id AS term_id,
                    t.term_name,
                    t.term_number,
                    t.start_date AS term_start,
                    t.end_date AS term_end
                 FROM academic_years ay
                 JOIN terms t
                   ON t.academic_year_id = ay.id
                  AND t.school_id = ay.school_id
                 WHERE ay.id = $1
                   AND t.id = $2
                   AND ay.school_id = $3
                   AND t.school_id = $3`,
                [
                    academicYearId,
                    termId,
                    auth.schoolId
                ]
            );

            if (periodResult.rowCount === 0) {
                return json({
                    success: false,
                    message: "The selected academic year or term is invalid for your school."
                }, 400);
            }

            period = periodResult.rows[0];

        } else {
            // Fallback for older requests without period parameters.
            const periodResult = await client.query(
                `SELECT
                    ay.id AS academic_year_id,
                    ay.year_name,
                    ay.start_date AS year_start,
                    ay.end_date AS year_end,
                    t.id AS term_id,
                    t.term_name,
                    t.term_number,
                    t.start_date AS term_start,
                    t.end_date AS term_end
                 FROM academic_years ay
                 JOIN terms t
                   ON t.academic_year_id = ay.id
                  AND t.school_id = ay.school_id
                 WHERE ay.school_id = $1
                   AND CURRENT_DATE BETWEEN ay.start_date AND ay.end_date
                   AND CURRENT_DATE BETWEEN t.start_date AND t.end_date
                 LIMIT 1`,
                [auth.schoolId]
            );

            if (periodResult.rowCount === 0) {
                return json({
                    success: false,
                    message: "No academic term is currently available. Select an academic period first."
                }, 400);
            }

            period = periodResult.rows[0];
        }

        const result = await client.query(
            `SELECT
                st.id,
                st.student_code,
                st.full_name,
                st.gender,
                st.date_of_birth,
                st.admission_date,
                st.status,
                st.created_at,

                se.id AS enrollment_id,
                se.class_id,
                se.subclass_id,
                se.start_date AS enrollment_start_date,
                se.end_date AS enrollment_end_date,
                se.status AS enrollment_status,

                c.class_name,

                scs.subclass_name,

                CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Ordinary Level'
                    WHEN 3 THEN 'Advanced Level'
                    ELSE 'Unknown'
                END AS class_level,

                $2::bigint AS academic_year_id,
                $3::bigint AS term_id,
                $4::varchar AS academic_year,
                $5::varchar AS term,
                $6::smallint AS term_number

             FROM student_enrollments se

             JOIN students st
               ON st.id = se.student_id
              AND st.school_id = se.school_id

             JOIN classes c
               ON c.id = se.class_id

             JOIN school_levels sl
               ON sl.school_id = se.school_id
              AND sl.level_id = c.level_id

             LEFT JOIN school_class_subclasses scs
               ON scs.id = se.subclass_id
              AND scs.school_id = se.school_id
              AND scs.academic_year_id = se.academic_year_id
              AND scs.class_id = se.class_id

             WHERE se.school_id = $1
               AND se.academic_year_id = $2
               AND se.term_id = $3

             ORDER BY
                c.class_name ASC,
                scs.subclass_name ASC NULLS FIRST,
                st.full_name ASC`,
            [
                auth.schoolId,
                period.academic_year_id,
                period.term_id,
                period.year_name,
                period.term_name,
                period.term_number
            ]
        );

        return json({
            success: true,
            period,
            students: result.rows
        });

    } catch (error) {
        console.error("Get students error:", error);

        return json({
            success: false,
            message: "Failed to load students."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}


/* =====================================================
   REGISTER STUDENT
   SCHOOL ADMIN + DOS

   CREATE STUDENT AND ENROLLMENT TOGETHER

   SUBCLASS SUPPORT:
   - subclass_id is optional
   - NULL means base class enrollment
   - A selected subclass must match:
       school_id
       academic_year_id
       class_id
       active status
===================================================== */

export async function onRequestPost(context) {
    const auth = await authenticateRole(
        context,
        ["school_admin", "dos"]
    );

    if (auth.error) return auth.error;

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not linked to a school."
        }, 403);
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid request data."
        }, 400);
    }

    const classId = Number(data.class_id);
    const academicYearId = Number(data.academic_year_id);
    const termId = Number(data.term_id);

    const fullName = String(data.full_name || "").trim();

    const gender = data.gender
        ? String(data.gender).trim()
        : null;

    const dateOfBirth = data.date_of_birth || null;
    const admissionDate = data.admission_date || null;

    // Subclass is optional for backward compatibility.
    const subclassId =
        data.subclass_id === undefined ||
        data.subclass_id === null ||
        data.subclass_id === ""
            ? null
            : Number(data.subclass_id);

    if (
        !Number.isSafeInteger(classId) ||
        classId <= 0 ||
        !Number.isSafeInteger(academicYearId) ||
        academicYearId <= 0 ||
        !Number.isSafeInteger(termId) ||
        termId <= 0 ||
        !fullName
    ) {
        return json({
            success: false,
            message: "Please provide a valid class, academic period and student name."
        }, 400);
    }

    if (
        subclassId !== null &&
        (
            !Number.isSafeInteger(subclassId) ||
            subclassId <= 0
        )
    ) {
        return json({
            success: false,
            message: "Please select a valid subclass."
        }, 400);
    }

    if (fullName.length > 200) {
        return json({
            success: false,
            message: "Student name must not exceed 200 characters."
        }, 400);
    }

    if (gender && gender.length > 20) {
        return json({
            success: false,
            message: "Invalid gender value."
        }, 400);
    }

    const studentCode =
        `STU-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           VALIDATE ACADEMIC YEAR AND TERM
        ============================================= */

        const periodResult = await client.query(
            `SELECT
                ay.id AS academic_year_id,
                ay.year_name,
                t.id AS term_id,
                t.start_date AS term_start,
                t.end_date AS term_end
             FROM academic_years ay
             JOIN terms t
               ON t.academic_year_id = ay.id
              AND t.school_id = ay.school_id
             WHERE ay.id = $1
               AND t.id = $2
               AND ay.school_id = $3
               AND t.school_id = $3`,
            [
                academicYearId,
                termId,
                auth.schoolId
            ]
        );

        if (periodResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "The selected academic year or term is invalid for your school."
            }, 400);
        }

        const period = periodResult.rows[0];

        /* =============================================
           VALIDATE CLASS
        ============================================= */

        const classResult = await client.query(
            `SELECT c.id
             FROM classes c
             JOIN school_levels sl
               ON sl.level_id = c.level_id
             WHERE c.id = $1
               AND sl.school_id = $2`,
            [
                classId,
                auth.schoolId
            ]
        );

        if (classResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "The selected class is not available to your school."
            }, 403);
        }

        /* =============================================
           VALIDATE SUBCLASS IF PROVIDED
        ============================================= */

        if (subclassId !== null) {
            const subclassResult = await client.query(
                `SELECT
                    id,
                    subclass_name
                 FROM school_class_subclasses
                 WHERE id = $1
                   AND school_id = $2
                   AND academic_year_id = $3
                   AND class_id = $4
                   AND LOWER(status) = 'active'
                 LIMIT 1`,
                [
                    subclassId,
                    auth.schoolId,
                    academicYearId,
                    classId
                ]
            );

            if (subclassResult.rowCount === 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The selected subclass is not active or does not belong to the selected class and academic year."
                }, 400);
            }
        }

        /* =============================================
           CREATE STUDENT
        ============================================= */

        const studentResult = await client.query(
            `INSERT INTO students (
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
                class_id,
                gender,
                date_of_birth,
                admission_date,
                status`,
            [
                auth.schoolId,
                classId,
                studentCode,
                fullName,
                gender,
                dateOfBirth,
                admissionDate
            ]
        );

        const student = studentResult.rows[0];

        /* =============================================
           CREATE STUDENT ENROLLMENT

           Existing registrations without a subclass
           continue to use NULL.
        ============================================= */

        const enrollmentResult = await client.query(
            `INSERT INTO student_enrollments (
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
             RETURNING
                id,
                student_id,
                class_id,
                academic_year_id,
                term_id,
                subclass_id,
                start_date,
                end_date,
                status`,
            [
                student.id,
                auth.schoolId,
                classId,
                period.academic_year_id,
                period.term_id,
                subclassId,
                period.term_start,
                period.term_end
            ]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Student registered successfully.",
            student: {
                ...student,
                subclass_id: subclassId,
                enrollment: enrollmentResult.rows[0]
            }
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Create student error:", error);

        return json({
            success: false,
            message: "Failed to register student."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
