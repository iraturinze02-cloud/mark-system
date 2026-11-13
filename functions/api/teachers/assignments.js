
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../_utils.js";

export async function onRequestPost(context) {
    const auth = await requireSchoolAdmin(context);
    if (auth.error) return auth.error;

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const teacherId = String(data.teacher_id || "").trim();
    const classId = String(data.class_id || "").trim();
    const subjectId = String(data.subject_id || "").trim();

    if (
        !/^[1-9]\d*$/.test(teacherId) ||
        !/^[1-9]\d*$/.test(classId) ||
        !/^[1-9]\d*$/.test(subjectId)
    ) {
        return json({
            success: false,
            message: "Valid teacher, class and subject are required."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");

        // Verify teacher belongs to this school.
        const teacher = await client.query(
            `SELECT id
             FROM teachers
             WHERE id = $1
               AND school_id = $2`,
            [teacherId, auth.schoolId]
        );

        if (teacher.rowCount === 0) {
            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Teacher not found in your school."
            }, 404);
        }

        // Verify class belongs to this school.
        const classResult = await client.query(
            `SELECT id, class_name
             FROM classes
             WHERE id = $1
               AND school_id = $2`,
            [classId, auth.schoolId]
        );

        if (classResult.rowCount === 0) {
            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Class not found in your school."
            }, 404);
        }

        // Verify subject exists.
        const subject = await client.query(
            `SELECT id, subject_name
             FROM subjects
             WHERE id = $1`,
            [subjectId]
        );

        if (subject.rowCount === 0) {
            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Subject not found."
            }, 404);
        }

        const result = await client.query(
            `INSERT INTO teacher_assignments (
                school_id,
                teacher_id,
                class_id,
                subject_id
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (teacher_id, class_id, subject_id)
            DO NOTHING
            RETURNING id`,
            [auth.schoolId, teacherId, classId, subjectId]
        );

        if (result.rowCount === 0) {
            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "This teacher already has this subject assigned to this class."
            }, 409);
        }

        await client.query("COMMIT");

        return json({
            success: true,
            message: "Teaching assignment saved successfully.",
            assignment: {
                id: result.rows[0].id,
                teacher_id: teacherId,
                class_id: classId,
                class_name: classResult.rows[0].class_name,
                subject_id: subjectId,
                subject_name: subject.rows[0].subject_name
            }
        }, 201);

    } catch (error) {
        await client?.query("ROLLBACK").catch(() => {});

        console.error("Assign teacher error:", error);

        return json({
            success: false,
            message: "Failed to save teaching assignment."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
