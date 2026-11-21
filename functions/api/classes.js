import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await authenticateRole(
    context,
    ["school_admin", "dos"]
);
    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                c.id::text AS id,
                c.class_name,
                el.id::text AS level_id,
                el.level_name AS class_level
             FROM classes c
             INNER JOIN school_levels sl
                ON sl.level_id = c.level_id
               AND sl.school_id = $1
             INNER JOIN education_levels el
                ON el.id = c.level_id
             ORDER BY c.id ASC`,
            [auth.schoolId]
        );

        return json({
            success: true,
            classes: result.rows
        });

    } catch (error) {
        console.error("Load classes error:", error);

        return json({
            success: false,
            message: "Failed to load classes."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
