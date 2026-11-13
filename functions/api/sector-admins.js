
import { connectDB, json, requireOwner } from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireOwner(context);
    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(`
            SELECT
                u.id AS admin_id,
                u.full_name,
                u.phone,
                u.status AS admin_status,
                u.sector_id,
                s.sector_name,
                s.sector_code
            FROM users u
            INNER JOIN sectors s ON s.id = u.sector_id
            WHERE u.role = 'sector_admin'
            ORDER BY s.sector_name ASC, u.full_name ASC
        `);

        return json({
            success: true,
            admins: result.rows
        });

    } catch (error) {
        return json({
            success: false,
            message: "Failed to retrieve sector administrators."
        }, 500);

    } finally {
        if (client) await client.end();
    }
}
