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

    const adminId = Number(data.id);
    const schoolId = Number(data.school_id);
    const full_name = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");

    if (
        !Number.isSafeInteger(adminId) || adminId <= 0 ||
        !Number.isSafeInteger(schoolId) || schoolId <= 0 ||
        !full_name ||
        !phone
    ) {
        return json({
            success: false,
            message: "Please provide valid administrator details."
        }, 400);
    }

    if (full_name.length > 200 || phone.length > 30) {
        return json({
            success: false,
            message: "Full name or phone number is too long."
        }, 400);
    }

    if (password && password.length < 8) {
        return json({
            success: false,
            message: "New password must contain at least 8 characters."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        // Confirm that this administrator belongs to this sector.
        const adminResult = await client.query(
            `SELECT u.id
             FROM users u
             INNER JOIN schools s
                ON s.id = u.school_id
             WHERE u.id = $1
               AND u.role = 'school_admin'
               AND s.sector_id = $2
             FOR UPDATE OF u`,
            [adminId, auth.sectorId]
        );

        if (adminResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "School administrator not found in your sector."
            }, 404);
        }

        // Confirm that the new school also belongs to this sector.
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

        // Prevent assigning a phone number already used by another account.
        const duplicate = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
               AND id <> $2`,
            [phone, adminId]
        );

        if (duplicate.rowCount > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already used by another account."
            }, 409);
        }

        let result;

        if (password) {
            const passwordHash = await bcrypt.hash(password, 12);

            result = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     school_id = $3,
                     password_hash = $4,
                     updated_at = NOW()
                 WHERE id = $5
                   AND role = 'school_admin'
                 RETURNING id, full_name, phone, school_id, role`,
                [full_name, phone, schoolId, passwordHash, adminId]
            );

        } else {
            result = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     school_id = $3,
                     updated_at = NOW()
                 WHERE id = $4
                   AND role = 'school_admin'
                 RETURNING id, full_name, phone, school_id, role`,
                [full_name, phone, schoolId, adminId]
            );
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "School administrator updated successfully.",
            admin: result.rows[0]
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Update school administrator error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number is already used by another account."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to update school administrator."
        }, 500);

    } finally {
        if (client) await client.end();
    }
}
