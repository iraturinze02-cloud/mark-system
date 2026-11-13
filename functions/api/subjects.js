import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireSchoolAdmin(context);

    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(`
            SELECT
                s.id,
                s.subject_name,
                s.subject_code,
                COALESCE(
                    ARRAY_AGG(scl.education_level)
                    FILTER (WHERE scl.education_level IS NOT NULL),
                    ARRAY[]::VARCHAR[]
                ) AS education_levels
            FROM subjects s
            LEFT JOIN subject_class_levels scl
                ON scl.subject_id = s.id
            GROUP BY s.id, s.subject_name, s.subject_code
            ORDER BY s.subject_name
        `);

        return json({
            success: true,
            subjects: result.rows
        });

    } catch (error) {
        console.error("Load subjects error:", error);

        return json({
            success: false,
            message: "Could not load subjects."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
