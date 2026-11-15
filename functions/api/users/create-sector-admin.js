
import bcrypt from "bcryptjs";

import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

/* =====================================================
   CREATE SECTOR AND SECTOR ADMINISTRATOR
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    let client;
    let transactionStarted = false;

    try {
        let data;

        try {
            data = await context.request.json();
        } catch {
            return json({
                success: false,
                message: "Invalid request data."
            }, 400);
        }

        const sectorName = String(data.sector_name || "").trim();
        const sectorCode = String(data.sector_code || "")
            .trim()
            .toUpperCase();

        const fullName = String(data.full_name || "").trim();
        const phone = String(data.phone || "").trim();
        const password = String(data.password || "");

        /* =============================================
           VALIDATION
        ============================================= */

        if (
            !sectorName ||
            !sectorCode ||
            !fullName ||
            !phone ||
            !password
        ) {
            return json({
                success: false,
                message: "Please complete all required fields."
            }, 400);
        }

        if (
            sectorName.length > 200 ||
            sectorCode.length > 30 ||
            fullName.length > 200 ||
            phone.length > 30
        ) {
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

        /* =============================================
           HASH PASSWORD
        ============================================= */

        const passwordHash = await bcrypt.hash(password, 12);

        /* =============================================
           DATABASE TRANSACTION
        ============================================= */

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           CREATE SECTOR
        ============================================= */

        const sectorResult = await client.query(
            `INSERT INTO sectors (
                sector_name,
                sector_code,
                status
            )
            VALUES ($1, $2, 'active')
            RETURNING id, sector_name, sector_code`,
            [sectorName, sectorCode]
        );

        const sectorId = sectorResult.rows[0].id;

        /* =============================================
           CREATE SECTOR ADMINISTRATOR
        ============================================= */

        const adminResult = await client.query(
            `INSERT INTO users (
                full_name,
                phone,
                password_hash,
                role,
                sector_id,
                school_id,
                status
            )
            VALUES ($1, $2, $3, 'sector_admin', $4, NULL, 'active')
            RETURNING id, full_name, phone, sector_id`,
            [
                fullName,
                phone,
                passwordHash,
                sectorId
            ]
        );

        /* =============================================
           COMMIT
        ============================================= */

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Sector and administrator registered successfully.",
            sector: sectorResult.rows[0],
            admin: adminResult.rows[0]
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("Create sector error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "Sector code or phone number already exists."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not register sector and administrator."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
