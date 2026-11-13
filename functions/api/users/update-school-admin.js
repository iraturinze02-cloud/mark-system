
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

    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");
    const schoolName = String(data.school_name || "").trim();

    if (!fullName || !phone || !password || !schoolName) {
        return json({
            success: false,
            message: "Please complete all required fields."
        }, 400);
    }

    if (fullName.length > 200 || schoolName.length > 200 || phone.length > 30) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (password.length < 8) {
        return json({
            success: false,
            message: "Password must contain at least 8 characters."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);
        await client.query("BEGIN");

        // Prevent two simultaneous requests from creating the same school.
        const lockKey = `${auth.sectorId}:${schoolName.toLowerCase()}`;
        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [lockKey]
        );

        // Find the school in this sector.
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
            // Generate a unique school code.
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

        // Check whether the phone number is already registered.
        const duplicate = await client.query(
            "SELECT id FROM users WHERE phone = $1 LIMIT 1",
            [phone]
        );

        if (duplicate.rows.length > 0) {
            await client.query("ROLLBACK");
            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await client.query(
            `INSERT INTO users
                (full_name, phone, password_hash, role, school_id, status)
             VALUES ($1, $2, $3, 'school_admin', $4, 'active')
             RETURNING id, full_name, phone, school_id`,
            [fullName, phone, passwordHash, schoolId]
        );

        await client.query("COMMIT");

        return json({
            success: true,
            message: "School administrator created successfully.",
            admin: result.rows[0]
        }, 201);

    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});

        console.error("Create school admin error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number or school code is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not create the school administrator."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
