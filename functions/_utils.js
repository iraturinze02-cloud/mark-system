import { Client } from "pg";
import { jwtVerify } from "jose";

export function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store"
        }
    });
}

export async function connectDB(context) {
    if (!context.env.HYPERDRIVE?.connectionString) {
        throw new Error("Database connection is not configured.");
    }

    const client = new Client({
        connectionString: context.env.HYPERDRIVE.connectionString,
        ssl: { rejectUnauthorized: false }
    });

    await client.connect();
    return client;
}

async function authenticateRole(context, expectedRole) {
    let client;

    try {
        const cookie = context.request.headers.get("Cookie") || "";

        const token = cookie
            .split(";")
            .map(item => item.trim())
            .find(item => item.startsWith("ses_token="))
            ?.substring("ses_token=".length);

        if (!token) {
            return {
                error: json({
                    success: false,
                    message: "Please log in."
                }, 401)
            };
        }

        if (!context.env.JWT_SECRET) {
            return {
                error: json({
                    success: false,
                    message: "Server authentication is not configured."
                }, 500)
            };
        }

        const secret = new TextEncoder().encode(context.env.JWT_SECRET);
        const { payload } = await jwtVerify(token, secret);

        const allowedRoles = Array.isArray(expectedRole)
    ? expectedRole
    : [expectedRole];

if (!payload.sub || !allowedRoles.includes(payload.role)) {
            return {
                error: json({
                    success: false,
                    message: "You are not authorized to access this resource."
                }, 403)
            };
        }

        client = await connectDB(context);

        const result = await client.query(
            `SELECT id, role, status, sector_id, school_id
             FROM users
             WHERE id = $1`,
            [payload.sub]
        );

        const user = result.rows[0];

       if (
    !user ||
    !allowedRoles.includes(user.role) ||
    user.status !== "active"
) {
            return {
                error: json({
                    success: false,
                    message: "Your account is not active or authorized."
                }, 403)
            };
        }
        if (Array.isArray(expectedRole)) {
    return {
        userId: String(user.id),
        role: user.role,
        sectorId: user.sector_id ? String(user.sector_id) : null,
        schoolId: user.school_id ? String(user.school_id) : null
    };
}

        if (expectedRole === "sector_admin") {
            if (!user.sector_id) {
                return {
                    error: json({
                        success: false,
                        message: "Your account is not assigned to a sector."
                    }, 403)
                };
            }

            return {
                userId: String(user.id),
                sectorId: String(user.sector_id)
            };
        }
        if (expectedRole === "school_admin") {
    if (!user.school_id) {
        return {
            error: json({
                success: false,
                message: "Your account is not assigned to a school."
            }, 403)
        };
    }

    return {
        userId: String(user.id),
        schoolId: String(user.school_id)
    };
}

        return {
            userId: String(user.id)
        };

    } catch (error) {
        console.error("Authentication error:", error);

        return {
            error: json({
                success: false,
                message: "Your session is invalid or has expired. Please log in again."
            }, 401)
        };

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}

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

