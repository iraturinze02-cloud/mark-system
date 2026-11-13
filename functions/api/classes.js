
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

        const result = await client.query(
            `SELECT
                id::text AS id,
                class_name,
                class_level
             FROM classes
             WHERE school_id = $1
             ORDER BY class_name ASC`,
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
