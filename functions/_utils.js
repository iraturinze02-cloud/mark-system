
import { Client } from "pg";
import { jwtVerify } from "jose";

export function json(data, status = 200) {
    return Response.json(data, { status });
}

export async function connectDB(context) {
    const client = new Client({
        connectionString: context.env.HYPERDRIVE.connectionString,
        ssl: { rejectUnauthorized: false }
    });

    await client.connect();
    return client;
}

export async function requireOwner(context) {
    try {
        const cookie = context.request.headers.get("Cookie") || "";
        const token = cookie
            .split(";")
            .map(item => item.trim())
            .find(item => item.startsWith("ses_token="))
            ?.substring("ses_token=".length);

        if (!token) {
            return { error: json({
                success: false,
                message: "Please log in."
            }, 401) };
        }

        if (!context.env.JWT_SECRET) {
            return { error: json({
                success: false,
                message: "Server authentication is not configured."
            }, 500) };
        }

        const secret = new TextEncoder().encode(context.env.JWT_SECRET);
        const { payload } = await jwtVerify(token, secret);

        if (!payload.sub || payload.role !== "owner") {
            return { error: json({
                success: false,
                message: "Access denied. Owner permission is required."
            }, 403) };
        }

        // Confirm that the account is still active and is still an owner.
        const client = await connectDB(context);

        try {
            const result = await client.query(
                `SELECT id, role, status
                 FROM users
                 WHERE id = $1`,
                [payload.sub]
            );

            const user = result.rows[0];

            if (!user || user.role !== "owner" || user.status !== "active") {
                return { error: json({
                    success: false,
                    message: "Your account is not authorized."
                }, 403) };
            }
        } finally {
            await client.end();
        }

        return { userId: payload.sub };

    } catch (error) {
        return { error: json({
            success: false,
            message: "Your session is invalid or has expired. Please log in again."
        }, 401) };
    }
}
