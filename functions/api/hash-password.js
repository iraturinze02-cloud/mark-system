
import bcrypt from "bcryptjs";

export async function onRequest(context) {
    if (context.request.method !== "POST") {
        return Response.json(
            { success: false, message: "Method not allowed." },
            { status: 405 }
        );
    }

    try {
        const data = await context.request.json();

        // Protect this temporary endpoint with a secret.

if (!context.env.OWNER_SETUP_KEY) {
    return Response.json(
        {
            success: false,
            message: "OWNER_SETUP_KEY is not available to this deployment."
        },
        { status: 500 }
    );
}

if (data.setupKey !== context.env.OWNER_SETUP_KEY) {
    return Response.json(
        {
            success: false,
            message: "The supplied setup key does not match."
        },
        { status: 401 }
    );
}


        if (
            typeof data.password !== "string" ||
            data.password.length < 8
        ) {
            return Response.json(
                { success: false, message: "Password must be at least 8 characters." },
                { status: 400 }
            );
        }

        const passwordHash = await bcrypt.hash(data.password, 12);

        return Response.json({
            success: true,
            password_hash: passwordHash
        });

    } catch (error) {
        return Response.json(
            { success: false, message: "Password hashing failed." },
            { status: 500 }
        );
    }
}
