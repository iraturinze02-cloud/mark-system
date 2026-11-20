
import {
    connectDB,
    json,
    requireSchoolAdmin
} from "../../_utils.js";

/* =====================================================
   GET SCHOOL ADMIN PROFILE OR SCHOOL USERS
===================================================== */

export async function onRequestGet(context) {

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

    let db;

    try {

        db = await connectDB(context);

        const url = new URL(context.request.url);
        const action = url.searchParams.get("action");

        /* =============================================
           GET LOGGED-IN SCHOOL ADMIN PROFILE
        ============================================= */

        if (action === "profile") {

            const result = await db.query(
                `
                SELECT
                    u.id,
                    u.full_name,
                    u.email,
                    u.phone,
                    u.role,
                    u.school_id,
                    u.status,
                    COALESCE(
    to_jsonb(s)->>'name',
    to_jsonb(s)->>'school_name'
) AS school_name
                FROM users u
                LEFT JOIN schools s
                    ON s.id = u.school_id
                WHERE u.id = $1
                  AND u.school_id = $2
                  AND u.role = 'school_admin'
                LIMIT 1
                `,
                [auth.userId, auth.schoolId]
            );

            if (!result.rows.length) {
                return json({
                    success: false,
                    message: "School administrator account not found."
                }, 404);
            }

            return json({
                success: true,
                user: result.rows[0]
            });
        }

        /* =============================================
           GET ALL USERS BELONGING TO THIS SCHOOL
        ============================================= */

        const result = await db.query(
            `
            SELECT
                u.id,
                u.full_name,
                u.email,
                u.phone,
                u.role,
                u.school_id,
                u.status,
                u.email_verified,
                u.must_change_password,
                u.created_at,
                t.gender,
                t.staff_number
            FROM users u
            LEFT JOIN teachers t
                ON t.user_id = u.id
               AND t.school_id = u.school_id
            WHERE u.school_id = $1
              AND u.role IN ('school_admin', 'teacher')
            ORDER BY
                CASE
                    WHEN u.role = 'school_admin' THEN 1
                    WHEN u.role = 'teacher' THEN 2
                    ELSE 3
                END,
                u.full_name ASC
            `,
            [auth.schoolId]
        );

        return json({
            success: true,
            users: result.rows
        });

    } catch (error) {

        console.error("SCHOOL USERS GET ERROR:", error);

        return json({
            success: false,
            message: "Unable to retrieve school users."
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
