
import {
    connectDB,
    json,
    requireSchoolAdmin
} from "../../../../_utils.js";

/* =====================================================
   ACTIVATE / DEACTIVATE SCHOOL USER
===================================================== */

export async function onRequestPatch(context) {

    const auth = await requireSchoolAdmin(context);

    if (auth.error) {
        return auth.error;
    }

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not assigned to a school."
        }, 403);
    }

    const userId = context.params.userId;

    if (!userId || !/^\d+$/.test(String(userId))) {
        return json({
            success: false,
            message: "Invalid user ID."
        }, 400);
    }

    let body;

    try {
        body = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid request body."
        }, 400);
    }

    const status = String(body.status || "").trim().toLowerCase();

    if (!["active", "inactive"].includes(status)) {
        return json({
            success: false,
            message: "Status must be active or inactive."
        }, 400);
    }

    // Prevent an administrator from deactivating their own account.
    if (String(userId) === String(auth.userId)) {
        return json({
            success: false,
            message: "You cannot change your own account status."
        }, 403);
    }

    let db;

    try {

        db = await connectDB(context);

        /*
          The school_id condition ensures that a school
          administrator cannot change users belonging
          to another school.
        */

        const result = await db.query(
            `
            UPDATE users
            SET status = $1
            WHERE id = $2
              AND school_id = $3
              AND role IN ('school_admin', 'teacher')
            RETURNING
                id,
                full_name,
                email,
                phone,
                role,
                status
            `,
            [
                status,
                userId,
                auth.schoolId
            ]
        );

        if (!result.rows.length) {
            return json({
                success: false,
                message: "User not found in your school."
            }, 404);
        }

        return json({
            success: true,
            message: status === "active"
                ? "User account activated successfully."
                : "User account deactivated successfully.",
            user: result.rows[0]
        });

    } catch (error) {

        console.error("SCHOOL USER STATUS ERROR:", error);

        return json({
            success: false,
            message: "Unable to update user status."
        }, 500);

    } finally {

        if (db) {
            try {
                await db.end();
            } catch (error) {
                console.error("DATABASE CLOSE ERROR:", error);
            }
        }
    }
}
