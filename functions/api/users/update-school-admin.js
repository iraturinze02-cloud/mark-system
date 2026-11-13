
import { connectDB, json, requireSectorAdmin } from "../../_utils.js";
import bcrypt from "bcryptjs";

export async function onRequestPost(context) {
    const auth = await requireSectorAdmin(context);
    if (auth.error) return auth.error;

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({ success: false, message: "Invalid request data." }, 400);
    }

    const id = String(data.id || "").trim();
    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");
    const schoolName = String(data.school_name || "").trim();

    if (!id || !/^\d+$/.test(id) || !fullName || !phone || !schoolName) {
        return json({
            success: false,
            message: "Please provide valid administrator details."
        }, 400);
    }

    if (fullName.length > 200 || schoolName.length > 200 || phone.length > 30) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (password && password.length < 8) {
        return json({
            success: false,
            message: "A new password must contain at least 8 characters."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);
        await client.query("BEGIN");

        // Confirm that this administrator belongs to the logged-in sector.
        const adminResult = await client.query(
            `SELECT u.id
             FROM users u
             JOIN schools s ON s.id = u.school_id
             WHERE u.id = $1
               AND u.role = 'school_admin'
               AND s.sector_id = $2
             FOR UPDATE OF u`,
            [id, auth.sectorId]
        );

        if (adminResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return json({
                success: false,
                message: "School administrator not found in your sector."
            }, 404);
        }

        // Check that the phone number is not used by another user.
        const duplicate = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1 AND id <> $2
             LIMIT 1`,
            [phone, id]
        );

        if (duplicate.rows.length > 0) {
            await client.query("ROLLBACK");
            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        // Prevent simultaneous creation of duplicate school records.
        const lockKey = `${auth.sectorId}:${schoolName.toLowerCase()}`;
        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [lockKey]
        );

        // Find the school in the administrator's sector.
        let schoolResult = await client.query(
            `SELECT id
             FROM schools
             WHERE sector_id = $1
               AND LOWER(TRIM(school_name)) = LOWER(TRIM($2))
             LIMIT 1`,
            [auth.sectorId, schoolName]
        );

        let schoolId;

        if (schoolResult.rows.length > 0) {
            schoolId = schoolResult.rows[0].id;
        } else {
            const schoolCode =
                `SCH-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

            const newSchool = await client.query(
                `INSERT INTO schools
                    (sector_id, school_name, school_code, status)
                 VALUES ($1, $2, $3, 'active')
                 RETURNING id`,
                [auth.sectorId, schoolName, schoolCode]
            );

            schoolId = newSchool.rows[0].id;
        }

        let result;

        if (password) {
            const passwordHash = await bcrypt.hash(password, 12);

            result = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     password_hash = $3,
                     school_id = $4,
                     updated_at = NOW()
                 WHERE id = $5
                 RETURNING id, full_name, phone, school_id`,
                [fullName, phone, passwordHash, schoolId, id]
            );
        } else {
            result = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     school_id = $3,
                     updated_at = NOW()
                 WHERE id = $4
                 RETURNING id, full_name, phone, school_id`,
                [fullName, phone, schoolId, id]
            );
        }

        await client.query("COMMIT");

        return json({
            success: true,
            message: "School administrator updated successfully.",
            admin: result.rows[0]
        });

    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});

        console.error("Update school admin error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number or school code is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not update the school administrator."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
