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

    const teacherId = Number(data.teacher_id);
    const classId = Number(data.class_id);
    const subjectId = Number(data.subject_id);

    if (
        !Number.isSafeInteger(teacherId) || teacherId <= 0 ||
        !Number.isSafeInteger(classId) || classId <= 0 ||
        !Number.isSafeInteger(subjectId) || subjectId <= 0
    ) {
        return json({
            success: false,
            message: "Please select a valid teacher, class and subject."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        const check = await client.query(`
            SELECT
                t.id AS teacher_id,
                c.id AS class_id,
                c.class_name,
                c.class_level,
                s.id AS subject_id,
                s.subject_name
            FROM teachers t
            JOIN classes c
                ON c.id = $2
               AND c.school_id = t.school_id
            JOIN subjects s
                ON s.id = $3
            JOIN subject_class_levels scl
                ON scl.subject_id = s.id
               AND scl.education_level = c.class_level
            WHERE t.id = $1
              AND t.school_id = $4
        `, [
            teacherId,
            classId,
            subjectId,
            auth.schoolId
        ]);

        if (!check.rows.length) {
            return json({
                success: false,
                message: "Invalid assignment. Check the teacher, class and subject. The subject may not be available for this class level."
            }, 400);
        }

        await client.query(`
            INSERT INTO teacher_assignments (
                school_id,
                teacher_id,
                class_id,
                subject_id
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (teacher_id, class_id, subject_id)
            DO NOTHING
        `, [
            auth.schoolId,
            teacherId,
            classId,
            subjectId
        ]);

        return json({
            success: true,
            message: "Teaching assignment saved successfully."
        });

    } catch (error) {
        console.error("Save teacher assignment error:", error);

        return json({
            success: false,
            message: "Could not save the teaching assignment."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
