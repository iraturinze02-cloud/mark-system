
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
    const confirmed = data.confirmed === true;

    if (!Number.isSafeInteger(studentId) || studentId <= 0) {
        return json({
            success: false,
            message: "Invalid student ID."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        /* =============================================
           STEP 1: CHECK DELETION AND REQUEST CONFIRMATION
        ============================================= */

        if (!confirmed) {
            const studentResult = await client.query(
                `SELECT
                    id,
                    full_name,
                    class_id
                 FROM students
                 WHERE id = $1
                   AND school_id = $2
                   AND status = 'inactive'`,
                [
                    studentId,
                    auth.schoolId
                ]
            );

            if (studentResult.rowCount === 0) {
                return json({
                    success: false,
                    message: "Inactive student not found in your school."
                }, 404);
            }

            const student = studentResult.rows[0];

            const marksResult = await client.query(
                `SELECT COUNT(*)::int AS marks_count
                 FROM marks
                 WHERE student_id = $1`,
                [student.id]
            );

            const marksCount = marksResult.rows[0].marks_count;

            const enrollmentResult = await client.query(
                `SELECT COUNT(*)::int AS enrollment_count
                 FROM student_enrollments
                 WHERE student_id = $1
                   AND school_id = $2`,
                [
                    student.id,
                    auth.schoolId
                ]
            );

            return json({
                success: true,
                requiresConfirmation: true,
                studentName: student.full_name,
                marksCount,
                enrollmentCount: enrollmentResult.rows[0].enrollment_count,
                hasMarks: marksCount > 0
            });
        }

        /* =============================================
           STEP 2: PERMANENT DELETION
        ============================================= */

        await client.query("BEGIN");
        transactionStarted = true;

        // Lock the inactive student during deletion.
        const studentResult = await client.query(
            `SELECT
                id,
                full_name,
                class_id
             FROM students
             WHERE id = $1
               AND school_id = $2
               AND status = 'inactive'
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
                message: "Inactive student not found in your school."
            }, 404);
        }

        const student = studentResult.rows[0];

        // Delete all marks belonging to this student,
        // including marks recorded in previous classes.
        const marksResult = await client.query(
            `DELETE FROM marks
             WHERE student_id = $1`,
            [student.id]
        );

        // Remove enrollments for all academic years and terms.
        // This also removes the student's subclass allocations.
        const enrollmentResult = await client.query(
            `DELETE FROM student_enrollments
             WHERE student_id = $1
               AND school_id = $2`,
            [
                student.id,
                auth.schoolId
            ]
        );

        // Permanently delete the inactive student.
        const deleteResult = await client.query(
            `DELETE FROM students
             WHERE id = $1
               AND school_id = $2
               AND status = 'inactive'
             RETURNING id`,
            [
                student.id,
                auth.schoolId
            ]
        );

        if (deleteResult.rowCount === 0) {
            throw new Error("Student could not be deleted.");
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Student permanently deleted.",
            deletedMarks: marksResult.rowCount,
            deletedEnrollments: enrollmentResult.rowCount
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Permanent student deletion error:", error);

        return json({
            success: false,
            message: "The student could not be permanently deleted. Related records may still exist."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
