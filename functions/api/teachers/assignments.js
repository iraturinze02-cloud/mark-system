
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../_utils.js";

export async function onRequestPost(context) {
    // ONLY SCHOOL ADMIN CAN ADD TEACHER ASSIGNMENTS
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

        // VALIDATE TEACHER, CLASS AND SUBJECT
        const check = await client.query(
            `SELECT
                t.id AS teacher_id,
                c.id AS class_id,
                c.class_name,
                CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                END AS class_level,
                s.id AS subject_id,
                s.subject_name
             FROM teachers t
             JOIN users u
               ON u.id = t.user_id
              AND u.school_id = t.school_id
              AND u.role = 'teacher'
             JOIN classes c
               ON c.id = $2
             JOIN school_levels sl
               ON sl.school_id = t.school_id
              AND sl.level_id = c.level_id
             JOIN subjects s
               ON s.id = $3
             JOIN subject_class_levels scl
               ON scl.subject_id = s.id
              AND scl.education_level = CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                  END
             WHERE t.id = $1
               AND t.school_id = $4`,
            [
                teacherId,
                classId,
                subjectId,
                auth.schoolId
            ]
        );

        if (check.rowCount === 0) {
            return json({
                success: false,
                message: "Invalid assignment. Check the teacher, class and subject. The subject may not be available for this class level."
            }, 400);
        }

        // SAVE ASSIGNMENT
        // MATCHES THE EXISTING EXPRESSION-BASED UNIQUE INDEX
        await client.query(
            `INSERT INTO teacher_assignments (
                school_id,
                teacher_id,
                class_id,
                subject_id
             )
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (
                teacher_id,
                school_id,
                class_id,
                subject_id,
                (COALESCE(academic_year_id, 0::bigint)),
                (COALESCE(subclass_id, 0::bigint))
             )
             DO NOTHING`,
            [
                auth.schoolId,
                teacherId,
                classId,
                subjectId
            ]
        );

        return json({
            success: true,
            message: "Teaching assignment saved successfully."
        });

    } catch (error) {
        console.error("SAVE TEACHER ASSIGNMENT ERROR:", {
            message: error?.message,
            code: error?.code,
            detail: error?.detail,
            constraint: error?.constraint,
            table: error?.table,
            column: error?.column,
            stack: error?.stack
        });

        return json({
            success: false,
            message: "Could not save the teaching assignment.",
            debug: {
                error: error?.message,
                code: error?.code,
                detail: error?.detail,
                constraint: error?.constraint
            }
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
