
import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

/* =====================================================
   UPDATE SECTOR ADMINISTRATOR
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

        const adminId = data.id;

        const fullName =
            String(data.full_name || "").trim();

        const phone =
            String(data.phone || "").trim();

        /* =============================================
           VALIDATION
        ============================================= */

        if (!adminId || !fullName || !phone) {

            return json({
                success: false,
                message: "Please complete all required fields."
            }, 400);
        }

        if (
            fullName.length > 200 ||
            phone.length > 30
        ) {
            return json({
                success: false,
                message: "One or more fields exceed the allowed length."
            }, 400);
        }

        /* =============================================
           CONNECT TO DATABASE
        ============================================= */

        client = await connectDB(context);

        await client.query("BEGIN");

        transactionStarted = true;

        /* =============================================
           FIND EXISTING SECTOR ADMINISTRATOR
        ============================================= */

        const existingResult = await client.query(
            `SELECT id, email
             FROM users
             WHERE id = $1
               AND role = 'sector_admin'
             LIMIT 1
             FOR UPDATE`,
            [adminId]
        );

        if (existingResult.rowCount === 0) {

            await client.query("ROLLBACK");

            transactionStarted = false;

            return json({
                success: false,
                message: "Sector administrator not found."
            }, 404);
        }

        /* =============================================
           UPDATE ADMINISTRATOR DETAILS

           Email remains unchanged.
           Password remains unchanged.
           Sector assignment remains unchanged.
        ============================================= */

        await client.query(
            `UPDATE users
             SET
                full_name = $1,
                phone = $2,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
               AND role = 'sector_admin'`,
            [
                fullName,
                phone,
                adminId
            ]
        );

        /* =============================================
           COMMIT
        ============================================= */

        await client.query("COMMIT");

        transactionStarted = false;

        return json({
            success: true,
            message: "Sector administrator updated successfully."
        });

    } catch (error) {

        if (client && transactionStarted) {

            await client.query("ROLLBACK").catch(() => {});

            transactionStarted = false;
        }

        console.error(
            "Update sector administrator error:",
            error
        );

        if (error.code === "23505") {

            return json({
                success: false,
                message: "This phone number is already in use."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not update the sector administrator."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}
