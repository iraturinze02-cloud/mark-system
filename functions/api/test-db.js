import { Client } from "pg";

export async function onRequest(context) {
    const client = new Client({
        connectionString: context.env.HYPERDRIVE.connectionString
    });

    try {
        await client.connect();

        const result = await client.query("SELECT 1 AS connected");

        return Response.json({
            success: true,
            message: "Neon database connection successful!",
            connected: result.rows[0].connected === 1
        });

    } catch (error) {
        console.error("Database connection error:", error);

        return Response.json({
            success: false,
            message: "Database connection failed. Check the Cloudflare logs."
        }, { status: 500 });

    } finally {
        await client.end().catch(() => {});
    }
}
