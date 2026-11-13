
import { connectDB, json, requireOwner } from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireOwner(context);
    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(`
            SELECT
                id,
                sector_name,
                sector_code,
                location,
                status,
                created_at
            FROM sectors
            ORDER BY sector_name ASC
        `);

        return json({
            success: true,
            sectors: result.rows
        });

    } catch (error) {
        return json({
            success: false,
            message: "Failed to retrieve sectors."
        }, 500);

    } finally {
        if (client) await client.end();
    }
}
