import { connectDB, requireSectorAdmin, json } from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireSectorAdmin(context);

    if (auth.error) {
        return auth.error;
    }

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                id,
                school_name,
                school_code,
                school_type,
                location,
                status
             FROM schools
             WHERE sector_id = $1
             ORDER BY school_name ASC`,
            [auth.sectorId]
        );

        return json({
            success: true,
            schools: result.rows
        });

    } catch (error) {
        console.error("Load sector schools error:", error);

        return json({
            success: false,
            message: "Failed to load schools."
        }, 500);

    } finally {
        if (client) await client.end();
    }
}
