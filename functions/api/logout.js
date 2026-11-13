
export async function onRequestPost() {
    return Response.json({
        success: true,
        message: "Logged out successfully."
    }, {
        headers: {
            "Set-Cookie": "ses_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
        }
    });
}
