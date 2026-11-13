
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";

export async function onRequest(context) {

    if (context.request.method !== "POST") {
        return Response.json({
            success: false,
            message: "Method not allowed."
        }, { status: 405 });
    }

    let client;

    try {

        // 1. READ LOGIN DATA
        let data;

        try {
            data = await context.request.json();
        } catch {
            return Response.json({
                success: false,
                message: "Invalid request data."
            }, { status: 400 });
        }

        const phone = String(data.phone || "").trim();
        const password = data.password;

        if (!phone || typeof password !== "string" || !password) {
            return Response.json({
                success: false,
                message: "Phone number and password are required."
            }, { status: 400 });
        }

        // 2. CONNECT TO NEON
        client = new Client({
            connectionString: context.env.HYPERDRIVE.connectionString
        });

        await client.connect();

        // 3. FIND USER
        const result = await client.query(
            `SELECT
                id,
                full_name,
                phone,
                password_hash,
                role,
                sector_id,
                school_id,
                status
             FROM users
             WHERE phone = $1
             LIMIT 1`,
            [phone]
        );

        if (result.rows.length === 0) {
            return Response.json({
                success: false,
                message: "Invalid phone number or password."
            }, { status: 401 });
        }

        const user = result.rows[0];

        // 4. CHECK ACCOUNT STATUS
        if (user.status !== "active") {
            return Response.json({
                success: false,
                message: "Your account is inactive or suspended. Contact your administrator."
            }, { status: 403 });
        }

        // 5. VERIFY PASSWORD
        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
            return Response.json({
                success: false,
                message: "Invalid phone number or password."
            }, { status: 401 });
        }

        // 6. VALIDATE ROLE
        const allowedRoles = [
            "owner",
            "sector_admin",
            "school_admin",
            "teacher"
        ];

        if (!allowedRoles.includes(user.role)) {
            return Response.json({
                success: false,
                message: "Invalid account role."
            }, { status: 403 });
        }

        // 7. VERIFY JWT SECRET
        const jwtSecret = context.env.JWT_SECRET;

        if (
            !jwtSecret ||
            new TextEncoder().encode(jwtSecret).length < 32
        ) {
            throw new Error("JWT_SECRET is missing or too short.");
        }

        // 8. CREATE JWT SESSION
        const secret = new TextEncoder().encode(jwtSecret);

        const token = await new SignJWT({
            role: user.role,
            sector_id: user.sector_id,
            school_id: user.school_id
        })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(String(user.id))
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(secret);

        // 9. RETURN SAFE USER DATA
        const safeUser = {
            id: String(user.id),
            full_name: user.full_name,
            phone: user.phone,
            role: user.role,
            sector_id: user.sector_id,
            school_id: user.school_id
        };

        return Response.json(
            {
                success: true,
                message: "Login successful.",
                user: safeUser
            },
            {
                status: 200,
                headers: {
                    "Set-Cookie":
                        `ses_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`
                }
            }
        );

    } catch (error) {

        console.error("LOGIN ERROR:", error);

        return Response.json({
            success: false,
            message: "A server error occurred. Please try again."
        }, { status: 500 });

    } finally {

        if (client) {
            await client.end().catch(error => {
                console.error("Database closing error:", error);
            });
        }
    }
}
