import bcrypt from "bcryptjs";
import {
    connectDB,
    requireSectorAdmin,
    json
} from "../../_utils.js";

export async function onRequestPost(context) {
    const auth = await requireSectorAdmin(context);

    if (auth.error) {
        return auth.error;
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const full_name = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");
    const schoolId = Number(data.school_id);

    if (!full_name || !phone || !password || !schoolId) {
        return json({
            success: false,
            message: "Full name, phone number, password and school are required."
        }, 400);
    }

    if (!Number.isSafeInteger(schoolId) || schoolId <= 0) {
        return json({
            success: false,
            message: "Invalid school selection."
        }, 400);
    }

    if (full_name.length > 200 || phone.length > 30) {
        return json({
            success: false,
            message: "Full name or phone number is too long."
        }, 400);
    }

    if (password.length < 8) {
        return json({
            success: false,
            message: "Password must contain at least 8 characters."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        // Verify that the selected school belongs to this sector.
        const schoolResult = await client.query(
            `SELECT id
             FROM schools
             WHERE id = $1
               AND sector_id = $2
               AND status = 'active'`,
            [schoolId, auth.sectorId]
        );

        if (schoolResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "The selected school does not belong to your sector or is inactive."
            }, 403);
        }

        // Check whether the phone number is already registered.
        const duplicate = await client.query(
            `SELECT id FROM users WHERE phone = $1`,
            [phone]
        );

        if (duplicate.rowCount > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await client.query(
            `INSERT INTO users (
                full_name,
                phone,
                password_hash,
                role,
                school_id,
                status
             )
             VALUES ($1, $2, $3, 'school_admin', $4, 'active')
             RETURNING id, full_name, phone, school_id, role`,
            [full_name, phone, passwordHash, schoolId]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "School administrator created successfully.",
            admin: result.rows[0]
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Create school administrator error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create school administrator."
        }, 500);

    } finally {
        if (client) await client.end();
    }
}
