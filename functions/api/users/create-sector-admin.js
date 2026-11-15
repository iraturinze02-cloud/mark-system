
import bcrypt from "bcryptjs";
import {
    connectDB,
    requireSectorAdmin,
    json
} from "../../_utils.js";

/* =====================================================
   CLASS HELPERS
===================================================== */

const CLASS_LEVELS = {
    P1: "Primary",
    P2: "Primary",
    P3: "Primary",
    P4: "Primary",
    P5: "Primary",
    P6: "Primary",

    S1: "Lower Secondary",
    S2: "Lower Secondary",
    S3: "Lower Secondary",

    S4: "Upper Secondary",
    S5: "Upper Secondary",
    S6: "Upper Secondary"
};

function validateClasses(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return {
            error: "Please select at least one class for this school."
        };
    }

    const classes = [
        ...new Set(
            value.map(item => String(item).trim().toUpperCase())
        )
    ];

    const invalid = classes.filter(
        className => !Object.prototype.hasOwnProperty.call(
            CLASS_LEVELS,
            className
        )
    );

    if (invalid.length > 0) {
        return {
            error: "One or more selected classes are invalid."
        };
    }

    return { classes };
}

async function ensureSchoolClasses(client, schoolId, classes) {
    for (const className of classes) {
        // Prevent simultaneous duplicate creation of this school class.
        const lockKey = `school-class:${schoolId}:${className}`;

        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [lockKey]
        );

        const existing = await client.query(
            `SELECT id
             FROM classes
             WHERE school_id = $1
               AND class_name = $2
             LIMIT 1`,
            [schoolId, className]
        );

        if (existing.rowCount === 0) {
            await client.query(
                `INSERT INTO classes (
                    school_id,
                    class_name,
                    class_level
                )
                VALUES ($1, $2, $3)`,
                [
                    schoolId,
                    className,
                    CLASS_LEVELS[className]
                ]
            );
        }
    }
}

/* =====================================================
   CREATE SCHOOL ADMIN
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireSectorAdmin(context);

    if (auth.error) return auth.error;

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");
    const schoolName = String(data.school_name || "").trim();

    const classValidation = validateClasses(data.classes);

    if (classValidation.error) {
        return json({
            success: false,
            message: classValidation.error
        }, 400);
    }

    const selectedClasses = classValidation.classes;

    const missing = [];

    if (!fullName) missing.push("full_name");
    if (!phone) missing.push("phone");
    if (!password) missing.push("password");
    if (!schoolName) missing.push("school_name");

    if (missing.length) {
        return json({
            success: false,
            message: "Please complete all required fields.",
            missing
        }, 400);
    }

    if (
        fullName.length > 200 ||
        phone.length > 30 ||
        schoolName.length > 200
    ) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (password.length < 8) {
        return json({
            success: false,
            message: "Password must contain at least 8 characters."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        // Prevent simultaneous creation of the same school.
        const lockKey =
            `${auth.sectorId}:${schoolName.toLowerCase()}`;

        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [lockKey]
        );

        // Find the school within the logged-in admin's sector.
        let schoolResult = await client.query(
            `SELECT id
             FROM schools
             WHERE sector_id = $1
               AND LOWER(TRIM(school_name)) = LOWER(TRIM($2))
             LIMIT 1`,
            [auth.sectorId, schoolName]
        );

        let schoolId;

        if (schoolResult.rowCount > 0) {
            schoolId = schoolResult.rows[0].id;
        } else {
            // Generate a unique school code.
            const schoolCode =
                `SCH-${Date.now()}-${crypto.randomUUID()
                    .slice(0, 8).toUpperCase()}`;

            const newSchool = await client.query(
                `INSERT INTO schools (
                    sector_id,
                    school_name,
                    school_code,
                    status
                )
                VALUES ($1, $2, $3, 'active')
                RETURNING id`,
                [auth.sectorId, schoolName, schoolCode]
            );

            schoolId = newSchool.rows[0].id;
        }

        // Create any selected classes that do not already exist.
        await ensureSchoolClasses(
            client,
            schoolId,
            selectedClasses
        );

        // Check duplicate phone number.
        const duplicate = await client.query(
            `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
            [phone]
        );

        if (duplicate.rowCount > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        // Hash the password before saving.
        const passwordHash = await bcrypt.hash(password, 12);

        const result = await client.query(
            `INSERT INTO users (
                full_name,
                phone,
                password_hash,
                role,
                school_id,
                status
            )
            VALUES ($1, $2, $3, 'school_admin', $4, 'active')
            RETURNING id, full_name, phone, school_id, role`,
            [fullName, phone, passwordHash, schoolId]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "School administrator created successfully.",
            admin: {
                ...result.rows[0],
                school_name: schoolName
            }
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("Create school administrator error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number or school code is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create school administrator."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
