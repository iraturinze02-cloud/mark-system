
/* =====================================================
   ACCOUNT SETUP SHARED HELPERS
   FILA MARKS SYSTEM
===================================================== */

const encoder = new TextEncoder();

/* =====================================================
   READ REQUEST BODY
===================================================== */

export async function readBody(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

/* =====================================================
   GENERATE RANDOM TOKEN
===================================================== */

export function generateRandomToken() {
    const bytes = new Uint8Array(32);

    crypto.getRandomValues(bytes);

    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   HASH TOKEN
===================================================== */

export async function hashToken(token) {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(token)
    );

    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   SIGN ACCOUNT TOKEN
   EXPIRES AFTER 10 MINUTES
===================================================== */

function base64url(value) {
    return btoa(value)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function decodeBase64url(value) {
    const base64 = value
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    return atob(
        base64 + "=".repeat((4 - base64.length % 4) % 4)
    );
}

async function getSigningKey(secret) {
    if (!secret) {
        throw new Error("JWT_SECRET is not configured.");
    }

    return crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        {
            name: "HMAC",
            hash: "SHA-256"
        },
        false,
        ["sign", "verify"]
    );
}

export async function createAccountToken(context, userId) {

    const payload = {
        userId: String(userId),
        purpose: "account_setup",
        expiresAt: Date.now() + (10 * 60 * 1000)
    };

    const encodedPayload = base64url(
        JSON.stringify(payload)
    );

    const key = await getSigningKey(
        context.env.JWT_SECRET
    );

    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(encodedPayload)
    );

    const encodedSignature = base64url(
        String.fromCharCode(
            ...new Uint8Array(signature)
        )
    );

    return `${encodedPayload}.${encodedSignature}`;
}

/* =====================================================
   VERIFY ACCOUNT TOKEN
===================================================== */

export async function verifyAccountToken(context, token) {

    try {

        if (!token || typeof token !== "string") {
            return null;
        }

        const parts = token.split(".");

        if (parts.length !== 2) {
            return null;
        }

        const [payloadPart, signaturePart] = parts;

        const key = await getSigningKey(
            context.env.JWT_SECRET
        );

        const signature = Uint8Array.from(
            decodeBase64url(signaturePart),
            character => character.charCodeAt(0)
        );

        const valid = await crypto.subtle.verify(
            "HMAC",
            key,
            signature,
            encoder.encode(payloadPart)
        );

        if (!valid) {
            return null;
        }

        const payload = JSON.parse(
            decodeBase64url(payloadPart)
        );

        if (
            payload.purpose !== "account_setup" ||
            !payload.userId ||
            !payload.expiresAt ||
            Date.now() > payload.expiresAt
        ) {
            return null;
        }

        return String(payload.userId);

    } catch {

        return null;

    }
}

/* =====================================================
   MASK EMAIL ADDRESS
===================================================== */

export function maskEmail(email) {

    const parts = String(email || "").split("@");

    if (parts.length !== 2) {
        return "";
    }

    const [name, domain] = parts;

    const visible = name.length > 2
        ? name.slice(0, 2)
        : name.slice(0, 1);

    return `${visible}${"*".repeat(
        Math.max(3, name.length - visible.length)
    )}@${domain}`;

}
