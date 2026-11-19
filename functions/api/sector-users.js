
import {
    connectDB,
    json
} from "../_utils.js";

import { jwtVerify } from "jose";

/* =====================================================
   CONFIGURATION
===================================================== */

const ALLOWED_ROLES = ["school_admin", "teacher"];

/* =====================================================
   READ HTTP-ONLY SESSION COOKIE
===================================================== */

function getSessionToken(request) {
    const cookieHeader = request.headers.get("Cookie") || "";

    const cookies = cookieHeader.split(";");

    for (const cookie of cookies) {
        const separator = cookie.indexOf("=");

        if (separator === -1) continue;

        const name = cookie.slice(0, separator).trim();
        const value = cookie.slice(separator + 1).trim();

        if (name === "ses_token") {
            return value;
        }
    }

    return null;
}

/* =====================================================
   AUTHENTICATE SECTOR ADMIN
===================================================== */

async function authenticateSectorAdmin(context, client) {

    const token = getSessionToken(context.request);

    if (!token) {
        return {
            success: false,
            status: 401,
            message: "Your session has expired. Please log in again."
        };
    }

    const jwtSecret = context.env.JWT_SECRET;

    if (
        !jwtSecret ||
        new TextEncoder().encode(jwtSecret).length < 32
    ) {
        throw new Error("JWT_SECRET is missing or invalid.");
    }

    let payload;

    try {
        const secret = new TextEncoder().encode(jwtSecret);

        const verified = await jwtVerify(token, secret, {
            algorithms: ["HS256"]
        });

        payload = verified.payload;

    } catch {
        return {
            success: false,
            status: 401,
            message: "Invalid or expired session. Please log in again."
        };
    }

    const userId = payload.sub;

    if (!userId || !/^\d+$/.test(String(userId))) {
        return {
            success: false,
            status: 401,
            message: "Invalid user session."
        };
    }

    if (payload.role !== "sector_admin") {
        return {
            success: false,
            status: 403,
            message: "Only Sector Administrators can access this resource."
        };
    }

    const userResult = await client.query(`
        SELECT
            id,
            role,
            sector_id,
            status
        FROM users
        WHERE id = $1
        LIMIT 1
    `, [userId]);

    if (userResult.rowCount === 0) {
        return {
            success: false,
            status: 401,
            message: "Your account could not be found."
        };
    }

    const user = userResult.rows[0];

    if (user.role !== "sector_admin") {
        return {
            success: false,
            status: 403,
            message: "You are not authorized to access this resource."
        };
    }

    if (user.status !== "active") {
        return {
            success: false,
            status: 403,
            message: "Your account is inactive."
        };
    }

    if (
        !user.sector_id ||
        String(user.sector_id) !== String(payload.sector_id)
    ) {
        return {
            success: false,
            status: 403,
            message: "Your sector authorization is invalid."
        };
    }

    return {
        success: true,
        userId: String(user.id),
        sectorId: String(user.sector_id)
    };
}

/* =====================================================
   VALIDATE REQUEST DATA
===================================================== */

function validId(value) {
    return /^\d+$/.test(String(value || ""));
}

function validStatus(value) {
    return value === "active" || value === "inactive";
}

/* =====================================================
   GET ALL SCHOOLS IN SECTOR
===================================================== */

async function getSchools(client, sectorId) {

    const result = await client.query(`
        SELECT
            s.id,
            s.school_name,
            s.school_code,
            s.school_type,
            s.location,
            s.phone,
            s.email,
            s.status,
            s.created_at,

            (
                SELECT COUNT(*)
                FROM teachers t
                INNER JOIN users u
                    ON u.id = t.user_id
                WHERE t.school_id = s.id
                  AND u.role = 'teacher'
            ) AS teacher_count,

            (
                SELECT COUNT(*)
                FROM teachers t
                INNER JOIN users u
                    ON u.id = t.user_id
                WHERE t.school_id = s.id
                  AND u.role = 'teacher'
                  AND u.status = 'active'
            ) AS active_teacher_count,

            (
                SELECT COUNT(*)
                FROM teachers t
                INNER JOIN users u
                    ON u.id = t.user_id
                WHERE t.school_id = s.id
                  AND u.role = 'teacher'
                  AND u.status <> 'active'
            ) AS inactive_teacher_count,

            (
                SELECT json_build_object(
                    'id', u.id,
                    'full_name', u.full_name,
                    'email', u.email,
                    'phone', u.phone,
                    'status', u.status,
                    'email_verified', u.email_verified,
                    'must_change_password', u.must_change_password
                )
                FROM users u
                WHERE u.school_id = s.id
                  AND u.role = 'school_admin'
                ORDER BY u.created_at ASC
                LIMIT 1
            ) AS school_admin

        FROM schools s

        WHERE s.sector_id = $1

        ORDER BY
            s.school_name ASC
    `, [sectorId]);

    return result.rows;
}

/* =====================================================
   GET ONE SCHOOL AND ITS USERS
===================================================== */

async function getSchoolDetails(client, sectorId, schoolId) {

    const schoolResult = await client.query(`
        SELECT
            s.id,
            s.school_name,
            s.school_code,
            s.school_type,
            s.location,
            s.phone,
            s.email,
            s.status,
            s.created_at,

            (
                SELECT COUNT(*)
                FROM teachers t
                INNER JOIN users u
                    ON u.id = t.user_id
                WHERE t.school_id = s.id
                  AND u.role = 'teacher'
            ) AS teacher_count,

            (
                SELECT COUNT(*)
                FROM teachers t
                INNER JOIN users u
                    ON u.id = t.user_id
                WHERE t.school_id = s.id
                  AND u.role = 'teacher'
                  AND u.status = 'active'
            ) AS active_teacher_count,

            (
                SELECT COUNT(*)
                FROM teachers t
                INNER JOIN users u
                    ON u.id = t.user_id
                WHERE t.school_id = s.id
                  AND u.role = 'teacher'
                  AND u.status <> 'active'
            ) AS inactive_teacher_count,

            (
                SELECT json_build_object(
                    'id', u.id,
                    'full_name', u.full_name,
                    'email', u.email,
                    'phone', u.phone,
                    'status', u.status,
                    'email_verified', u.email_verified,
                    'must_change_password', u.must_change_password
                )
                FROM users u
                WHERE u.school_id = s.id
                  AND u.role = 'school_admin'
                ORDER BY u.created_at ASC
                LIMIT 1
            ) AS school_admin

        FROM schools s

        WHERE s.id = $1
          AND s.sector_id = $2

        LIMIT 1
    `, [schoolId, sectorId]);

    if (schoolResult.rowCount === 0) {
        return null;
    }

    const school = schoolResult.rows[0];

    const usersResult = await client.query(`
        SELECT
            u.id,
            u.full_name,
            u.phone,
            u.email,
            u.role,
            u.status,
            u.email_verified,
            u.must_change_password,
            u.created_at

        FROM users u

        WHERE u.school_id = $1
          AND u.role = ANY($2::varchar[])

        ORDER BY
            CASE u.role
                WHEN 'school_admin' THEN 1
                WHEN 'teacher' THEN 2
                ELSE 3
            END,
            u.full_name ASC
    `, [schoolId, ALLOWED_ROLES]);

    school.users = usersResult.rows;

    return school;
}

/* =====================================================
   ACTIVATE / DEACTIVATE SCHOOL
===================================================== */

async function toggleSchool(
    client,
    sectorId,
    schoolId,
    status
) {

    const result = await client.query(`
        UPDATE schools
        SET status = $1
        WHERE id = $2
          AND sector_id = $3
        RETURNING
            id,
            school_name,
            status
    `, [status, schoolId, sectorId]);

    if (result.rowCount === 0) {
        return {
            success: false,
            status: 404,
            message: "School not found in your sector."
        };
    }

    return {
        success: true,
        school: result.rows[0],
        message: `School ${status === "active"
            ? "activated"
            : "deactivated"} successfully.`
    };
}

/* =====================================================
   ACTIVATE / DEACTIVATE USER
===================================================== */

async function toggleUser(
    client,
    sectorId,
    userId,
    status
) {

    const result = await client.query(`
        UPDATE users u

        SET
            status = $1,
            updated_at = CURRENT_TIMESTAMP

        WHERE u.id = $2

          AND u.role = ANY($3::varchar[])

          AND EXISTS (
              SELECT 1
              FROM schools s
              WHERE s.id = u.school_id
                AND s.sector_id = $4
          )

        RETURNING
            u.id,
            u.full_name,
            u.role,
            u.status
    `, [
        status,
        userId,
        ALLOWED_ROLES,
        sectorId
    ]);

    if (result.rowCount === 0) {
        return {
            success: false,
            status: 404,
            message: "User not found in your sector or the account cannot be modified."
        };
    }

    const user = result.rows[0];

    return {
        success: true,
        user,
        message: `${user.full_name}'s account has been ${
            status === "active" ? "activated" : "deactivated"
        } successfully.`
    };
}

/* =====================================================
   MAIN REQUEST HANDLER
===================================================== */

export async function onRequest(context) {

    const method = context.request.method;

    if (!["GET", "POST"].includes(method)) {
        return json({
            success: false,
            message: "Method not allowed."
        }, 405);
    }

    let client;

    try {

        client = await connectDB(context);

        /* =============================================
           AUTHENTICATE SECTOR ADMIN
        ============================================= */

        const auth = await authenticateSectorAdmin(
            context,
            client
        );

        if (!auth.success) {
            return json({
                success: false,
                message: auth.message
            }, auth.status);
        }

        const sectorId = auth.sectorId;

        /* =============================================
           READ REQUEST
        ============================================= */

        let data = {};

        if (method === "GET") {

            data = {
                action: context.request.url
                    ? new URL(context.request.url).searchParams.get("action")
                    : null,

                school_id: new URL(context.request.url)
                    .searchParams.get("school_id")
            };

        } else {

            try {
                data = await context.request.json();
            } catch {
                return json({
                    success: false,
                    message: "Invalid request data."
                }, 400);
            }
        }

        const action = String(data.action || "").trim();

        /* =============================================
           ACTION: GET SCHOOLS
        ============================================= */

        if (action === "get_schools") {

            if (method !== "GET") {
                return json({
                    success: false,
                    message: "Invalid request method."
                }, 405);
            }

            const schools = await getSchools(
                client,
                sectorId
            );

            return json({
                success: true,
                schools
            });
        }

        /* =============================================
           ACTION: GET SCHOOL DETAILS
        ============================================= */

        if (action === "get_school_details") {

            if (method !== "GET") {
                return json({
                    success: false,
                    message: "Invalid request method."
                }, 405);
            }

            const schoolId = String(data.school_id || "");

            if (!validId(schoolId)) {
                return json({
                    success: false,
                    message: "Invalid school ID."
                }, 400);
            }

            const school = await getSchoolDetails(
                client,
                sectorId,
                schoolId
            );

            if (!school) {
                return json({
                    success: false,
                    message: "School not found in your sector."
                }, 404);
            }

            return json({
                success: true,
                school
            });
        }

        /* =============================================
           ACTION: TOGGLE SCHOOL
        ============================================= */

        if (action === "toggle_school") {

            if (method !== "POST") {
                return json({
                    success: false,
                    message: "Invalid request method."
                }, 405);
            }

            const schoolId = String(data.school_id || "");
            const status = String(data.status || "");

            if (!validId(schoolId) || !validStatus(status)) {
                return json({
                    success: false,
                    message: "Invalid school ID or status."
                }, 400);
            }

            const result = await toggleSchool(
                client,
                sectorId,
                schoolId,
                status
            );

            return json(result, result.success ? 200 : result.status);
        }

        /* =============================================
           ACTION: TOGGLE USER
        ============================================= */

        if (action === "toggle_user") {

            if (method !== "POST") {
                return json({
                    success: false,
                    message: "Invalid request method."
                }, 405);
            }

            const userId = String(data.user_id || "");
            const status = String(data.status || "");

            if (!validId(userId) || !validStatus(status)) {
                return json({
                    success: false,
                    message: "Invalid user ID or status."
                }, 400);
            }

            const result = await toggleUser(
                client,
                sectorId,
                userId,
                status
            );

            return json(result, result.success ? 200 : result.status);
        }

        /* =============================================
           UNKNOWN ACTION
        ============================================= */

        return json({
            success: false,
            message: "Unknown API action."
        }, 400);

    } catch (error) {

        console.error("SECTOR USERS API ERROR:", error);

        return json({
            success: false,
            message: "A server error occurred. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(error => {
                console.error("Database closing error:", error);
            });
        }
    }
}
