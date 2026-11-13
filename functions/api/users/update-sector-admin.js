
import bcrypt from "bcryptjs";
import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

export async function onRequestPost(context) {
    const auth = await requireOwner(context);
    if (auth.error) return auth.error;

    let client;

    try {
        const data = await context.request.json();

        const sectorId = data.sectorId;
        const adminId = data.adminId;
        const sectorName = String(data.sectorName || "").trim();
        const sectorCode = String(data.sectorCode || "").trim().toUpperCase();
        const location = String(data.location || "").trim() || null;
        const fullName = String(data.fullName || data.adminName || "").trim();
        const phone = String(data.phone || "").trim();
        const password = String(data.password || "");

        if (!sectorId || !adminId || !sectorName || !sectorCode || !fullName || !phone) {
            return json({
                success: false,
                message: "Missing required information."
            }, 400);
        }

        if (password && password.length < 8) {
            return json({
                success: false,
                message: "New password must contain at least 8 characters."
            }, 400);
        }

        const passwordHash = password
            ? await bcrypt.hash(password, 12)
            : null;

        client = await connectDB(context);
        await client.query("BEGIN");

        const sectorResult = await client.query(`
            UPDATE sectors
            SET
                sector_name = $1,
                sector_code = $2,
                location = $3
            WHERE id = $4
            RETURNING id
        `, [sectorName, sectorCode, location, sectorId]);

        if (sectorResult.rowCount === 0) {
            await client.query("ROLLBACK");
            return json({
                success: false,
                message: "Sector not found."
            }, 404);
        }

        const adminResult = await client.query(`
            UPDATE users
            SET
                full_name = $1,
                phone = $2,
                password_hash = COALESCE($3, password_hash),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $4
              AND sector_id = $5
              AND role = 'sector_admin'
            RETURNING id
        `, [fullName, phone, passwordHash, adminId, sectorId]);

        if (adminResult.rowCount === 0) {
            await client.query("ROLLBACK");
            return json({
                success: false,
                message: "Sector administrator not found."
            }, 404);
        }

        await client.query("COMMIT");

        return json({
            success: true,
            message: "Sector and administrator updated successfully."
        });

    } catch (error) {
        if (client) await client.query("ROLLBACK");

        if (error.code === "23505") {
            return json({
                success: false,
                message: "That sector code or phone number is already in use."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not update the sector administrator."
        }, 500);

    } finally {
        if (client) await client.end();
    }
}
