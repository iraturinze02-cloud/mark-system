
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
                subject_name,
                subject_code
             FROM subjects
             ORDER BY subject_name ASC`
        );

        return json({
            success: true,
            subjects: result.rows
        });

    } catch (error) {
        console.error("Load subjects error:", error);

        return json({
            success: false,
            message: "Failed to load subjects."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
