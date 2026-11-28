
import {
    connectDB,
    authenticateRole,
    json
} from "../../_utils.js";

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

    const studentId = Number(data.id);
    const classId = Number(data.class_id);

    const fullName = String(data.full_name || "").trim();

    const gender = data.gender
        ? String(data.gender).trim()
        : null;

    const dateOfBirth = data.date_of_birth || null;
    const admissionDate = data.admission_date || null;

    // Academic period is optional for backward compatibility.
    const hasAcademicYear =
        data.academic_year_id !== undefined &&
        data.academic_year_id !== null &&
        data.academic_year_id !== "";

    const hasTerm =
        data.term_id !== undefined &&
        data.term_id !== null &&
        data.term_id !== "";

    const academicYearId = hasAcademicYear
        ? Number(data.academic_year_id)
        : null;

    const termId = hasTerm
        ? Number(data.term_id)
        : null;

    // Subclass is optional.
    const subclassId =
        data.subclass_id === undefined ||
        data.subclass_id === null ||
        data.subclass_id === ""
            ? null
            : Number(data.subclass_id);

    if (
        !Number.isSafeInteger(studentId) ||
        studentId <= 0 ||
        !Number.isSafeInteger(classId) ||
        classId <= 0 ||
        !fullName
    ) {
        return json({
            success: false,
            message: "Please provide valid student details."
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

    // If one period field is supplied, both must be supplied.
    if (hasAcademicYear !== hasTerm) {
        return json({
            success: false,
            message: "Please provide both the academic year and term."
        }, 400);
    }

    if (
        hasAcademicYear &&
        (
            !Number.isSafeInteger(academicYearId) ||
            academicYearId <= 0 ||
            !Number.isSafeInteger(termId) ||
            termId <= 0
        )
    ) {
        return json({
            success: false,
            message: "Invalid academic period."
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

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           VALIDATE STUDENT
        ============================================= */

        const studentResult = await client.query(
            `SELECT id
             FROM students
             WHERE id = $1
               AND school_id = $2
             FOR UPDATE`,
            [
                studentId,
                auth.schoolId
            ]
        );

        if (studentResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Student not found in your school."
            }, 404);
        }

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
           VALIDATE PERIOD IF PROVIDED
        ============================================= */

        if (hasAcademicYear) {
            const periodResult = await client.query(
                `SELECT
                    ay.id AS academic_year_id,
                    t.id AS term_id
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
        }

        /* =============================================
           VALIDATE SUBCLASS IF PROVIDED
        ============================================= */

        if (subclassId !== null) {
            if (!hasAcademicYear) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "An academic year and term are required when assigning a subclass."
                }, 400);
            }

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
           UPDATE STUDENT DETAILS
        ============================================= */

        const updateStudentResult = await client.query(
            `UPDATE students
             SET
                class_id = $1,
                full_name = $2,
                gender = $3,
                date_of_birth = $4,
                admission_date = $5
             WHERE id = $6
               AND school_id = $7
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
                classId,
                fullName,
                gender,
                dateOfBirth,
                admissionDate,
                studentId,
                auth.schoolId
            ]
        );

        const student = updateStudentResult.rows[0];

        /* =============================================
           UPDATE SELECTED PERIOD ENROLLMENT

           Only the selected academic year and term
           are changed. Historical enrollments remain
           untouched.
        ============================================= */

        let enrollment = null;

        if (hasAcademicYear) {
            const enrollmentResult = await client.query(
                `UPDATE student_enrollments
                 SET
                    class_id = $1,
                    subclass_id = $2
                 WHERE student_id = $3
                   AND school_id = $4
                   AND academic_year_id = $5
                   AND term_id = $6
                 RETURNING
                    id,
                    student_id,
                    class_id,
                    academic_year_id,
                    term_id,
                    subclass_id,
                    status`,
                [
                    classId,
                    subclassId,
                    studentId,
                    auth.schoolId,
                    academicYearId,
                    termId
                ]
            );

            if (enrollmentResult.rowCount === 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "No enrollment was found for this student in the selected academic period. The student details were not changed."
                }, 404);
            }

            enrollment = enrollmentResult.rows[0];
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Student updated successfully.",
            student: {
                ...student,
                subclass_id: enrollment
                    ? enrollment.subclass_id
                    : undefined,
                enrollment
            }
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Update student error:", error);

        return json({
            success: false,
            message: "Failed to update student."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
