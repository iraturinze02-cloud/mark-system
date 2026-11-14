import { Client } from "pg";
import { jwtVerify } from "jose";

/* =====================================================
   JSON RESPONSE
===================================================== */

export function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store"
        }
    });
}

/* =====================================================
   DATABASE CONNECTION
===================================================== */

export async function connectDB(context) {
    const connectionString =
        context.env.HYPERDRIVE?.connectionString;

    if (!connectionString) {
        throw new Error(
            "Database connection is not configured."
        );
    }

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    await client.connect();

    return client;
}

/* =====================================================
   READ SESSION COOKIE
===================================================== */

function getCookie(request, name) {
    const cookieHeader =
        request.headers.get("Cookie") || "";

    const cookies = cookieHeader.split(";");

    for (const cookie of cookies) {
        const separator = cookie.indexOf("=");

        if (separator === -1) continue;

        const key = cookie.slice(0, separator).trim();
        const value = cookie.slice(separator + 1).trim();

        if (key === name) {
            return decodeURIComponent(value);
        }
    }

    return null;
}

/* =====================================================
   AUTHENTICATE USER AND CHECK ROLE
===================================================== */

export async function authenticateRole(
    context,
    expectedRole
) {
    const token = getCookie(
        context.request,
        "ses_token"
    );

    if (!token) {
        return {
            error: json({
                success: false,
                message: "Please log in to continue."
            }, 401)
        };
    }

    const secret = context.env.JWT_SECRET;

    if (!secret) {
        return {
            error: json({
                success: false,
                message: "Authentication is not configured."
            }, 500)
        };
    }

    let payload;

    try {
        const secretKey = new TextEncoder().encode(secret);

        const verified = await jwtVerify(
            token,
            secretKey
        );

        payload = verified.payload;

    } catch {
        return {
            error: json({
                success: false,
                message: "Your session has expired. Please log in again."
            }, 401)
        };
    }

    const userId = payload.sub;

    if (!userId) {
        return {
            error: json({
                success: false,
                message: "Invalid login session."
            }, 401)
        };
    }

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                id,
                full_name,
                phone,
                role,
                sector_id,
                school_id,
                status
             FROM users
             WHERE id = $1
             LIMIT 1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return {
                error: json({
                    success: false,
                    message: "User account not found."
                }, 401)
            };
        }

        const user = result.rows[0];

        if (user.status !== "active") {
            return {
                error: json({
                    success: false,
                    message: "Your account is not active."
                }, 403)
            };
        }

        if (payload.role !== user.role) {
            return {
                error: json({
                    success: false,
                    message: "Your session permissions have changed. Please log in again."
                }, 401)
            };
        }

        const allowedRoles = Array.isArray(expectedRole)
            ? expectedRole
            : [expectedRole];

        if (!allowedRoles.includes(user.role)) {
            return {
                error: json({
                    success: false,
                    message: "You are not authorized to perform this action."
                }, 403)
            };
        }

        return {
            userId: String(user.id),
            fullName: user.full_name,
            phone: user.phone,
            role: user.role,
            sectorId: user.sector_id
                ? String(user.sector_id)
                : null,
            schoolId: user.school_id
                ? String(user.school_id)
                : null
        };

    } catch (error) {
        console.error("Authentication error:", error);

        return {
            error: json({
                success: false,
                message: "Authentication failed."
            }, 500)
        };

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}

/* =====================================================
   ROLE-SPECIFIC AUTHENTICATION HELPERS
===================================================== */

export async function requireOwner(context) {
    return authenticateRole(context, "owner");
}

export async function requireSectorAdmin(context) {
    return authenticateRole(context, "sector_admin");
}

export async function requireSchoolAdmin(context) {
    return authenticateRole(context, "school_admin");
}

export async function requireTestUser(context) {
    return authenticateRole(context, [
        "sector_admin",
        "school_admin",
        "teacher"
    ]);
}
