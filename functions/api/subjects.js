
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
                c.id,
                c.class_name,
                c.level_id,
                el.level_name AS class_level
            FROM classes c
            LEFT JOIN education_levels el
                ON el.id = c.level_id
            ORDER BY c.class_name
        `);

        return json({
            success: true,
            classes: result.rows
        });

    } catch (error) {
        console.error("Load classes error:", error);

        return json({
            success: false,
            message: "Could not load classes."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
