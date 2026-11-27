
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

function validId(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0
        ? number
        : null;
}

function cleanSubclassName(value) {
    if (typeof value !== "string") return null;

    const name = value.trim();

    if (!name || name.length > 50) return null;

    return name;
}

async function authenticate(context) {
    const auth = await authenticateRole(context, [
        "school_admin",
        "dos"
    ]);

    if (auth.error) return {
        error: auth.error
    };

    const schoolId = validId(auth.schoolId);

    if (!schoolId) {
        return {
            error: json({
                success: false,
                message: "Your account is not linked to a valid school."
            }, 403)
        };
    }

    return {
        auth,
        schoolId
    };
}

/* =====================================================
   GET: LOAD CLASSES AND SUBCLASSES

   GET /api/subclasses?academic_year_id=2
===================================================== */

export async function onRequestGet(context) {
    const access = await authenticate(context);

    if (access.error) return access.error;

    const { schoolId } = access;

    const url = new URL(context.request.url);

    const academicYearId = validId(
        url.searchParams.get("academic_year_id")
    );

    if (!academicYearId) {
        return json({
            success: false,
            message: "Please select a valid academic year."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        // Confirm that the academic year belongs to this school.
        const yearResult = await client.query(
            `
            SELECT id, year_name
            FROM academic_years
            WHERE id = $1
              AND school_id = $2
            `,
            [academicYearId, schoolId]
        );

        if (yearResult.rowCount === 0) {
            return json({
                success: false,
                message: "The selected academic year does not belong to your school."
            }, 403);
        }

        // Load only classes enabled for this school.
        // Subclasses are specific to the selected academic year.
        const result = await client.query(
            `
            SELECT
                c.id::text AS class_id,
                c.class_name,

                el.id::text AS level_id,
                el.level_name,

                scs.id::text AS subclass_id,
                scs.subclass_name,
                scs.status AS subclass_status

            FROM classes c

            INNER JOIN school_levels sl
                ON sl.level_id = c.level_id
               AND sl.school_id = $1

            INNER JOIN education_levels el
                ON el.id = c.level_id

            LEFT JOIN school_class_subclasses scs
                ON scs.school_id = $1
               AND scs.academic_year_id = $2
               AND scs.class_id = c.id

            ORDER BY
                c.id ASC,
                scs.subclass_name ASC NULLS LAST
            `,
            [schoolId, academicYearId]
        );

        const classesMap = new Map();

        for (const row of result.rows) {
            const classId = String(row.class_id);

            if (!classesMap.has(classId)) {
                classesMap.set(classId, {
                    id: classId,
                    class_name: row.class_name,
                    level_id: String(row.level_id),
                    level_name: row.level_name,
                    subclasses: []
                });
            }

            if (row.subclass_id !== null) {
                classesMap.get(classId).subclasses.push({
                    id: String(row.subclass_id),
                    subclass_name: row.subclass_name,
                    status: row.subclass_status
                });
            }
        }

        return json({
            success: true,
            academic_year: {
                id: String(yearResult.rows[0].id),
                year_name: yearResult.rows[0].year_name
            },
            classes: Array.from(classesMap.values())
        });

    } catch (error) {
        console.error("Load subclasses error:", {
            message: error?.message,
            code: error?.code
        });

        return json({
            success: false,
            message: "Failed to load subclasses."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}


/* =====================================================
   POST: CREATE SUBCLASS

   POST /api/subclasses

   {
       "academic_year_id": 2,
       "class_id": 6,
       "subclass_name": "A"
   }
===================================================== */

export async function onRequestPost(context) {
    const access = await authenticate(context);

    if (access.error) return access.error;

    const { schoolId } = access;

    let body;

    try {
        body = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid request data."
        }, 400);
    }

    const academicYearId = validId(body.academic_year_id);
    const classId = validId(body.class_id);
    const subclassName = cleanSubclassName(body.subclass_name);

    if (!academicYearId || !classId || !subclassName) {
        return json({
            success: false,
            message: "Academic year, class and a valid subclass name are required."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        // Confirm academic year belongs to this school.
        const yearResult = await client.query(
            `
            SELECT id
            FROM academic_years
            WHERE id = $1
              AND school_id = $2
            `,
            [academicYearId, schoolId]
        );

        if (yearResult.rowCount === 0) {
            return json({
                success: false,
                message: "Invalid academic year for your school."
            }, 403);
        }

        // Confirm the base class is enabled for this school.
        const classResult = await client.query(
            `
            SELECT c.id
            FROM classes c

            INNER JOIN school_levels sl
                ON sl.level_id = c.level_id
               AND sl.school_id = $1

            WHERE c.id = $2
            `,
            [schoolId, classId]
        );

        if (classResult.rowCount === 0) {
            return json({
                success: false,
                message: "This class is not enabled for your school."
            }, 403);
        }

        // Prevent duplicates even when letter casing differs.
        const duplicateResult = await client.query(
            `
            SELECT id
            FROM school_class_subclasses
            WHERE school_id = $1
              AND academic_year_id = $2
              AND class_id = $3
              AND LOWER(subclass_name) = LOWER($4)
            `,
            [
                schoolId,
                academicYearId,
                classId,
                subclassName
            ]
        );

        if (duplicateResult.rowCount > 0) {
            return json({
                success: false,
                message: "This subclass already exists for the selected class and academic year."
            }, 409);
        }

        const result = await client.query(
            `
            INSERT INTO school_class_subclasses (
                school_id,
                academic_year_id,
                class_id,
                subclass_name
            )
            VALUES ($1, $2, $3, $4)
            RETURNING
                id,
                school_id,
                academic_year_id,
                class_id,
                subclass_name,
                status,
                created_at
            `,
            [
                schoolId,
                academicYearId,
                classId,
                subclassName
            ]
        );

        return json({
            success: true,
            message: "Subclass created successfully.",
            subclass: result.rows[0]
        }, 201);

    } catch (error) {
        console.error("Create subclass error:", {
            message: error?.message,
            code: error?.code
        });

        return json({
            success: false,
            message: "Failed to create subclass."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}


/* =====================================================
   PATCH: RENAME OR CHANGE SUBCLASS STATUS

   PATCH /api/subclasses

   Rename:
   {
       "id": 1,
       "subclass_name": "B"
   }

   Deactivate:
   {
       "id": 1,
       "status": "inactive"
   }

   Activate:
   {
       "id": 1,
       "status": "active"
   }
===================================================== */

export async function onRequestPatch(context) {
    const access = await authenticate(context);

    if (access.error) return access.error;

    const { schoolId } = access;

    let body;

    try {
        body = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid request data."
        }, 400);
    }

    const subclassId = validId(body.id);

    if (!subclassId) {
        return json({
            success: false,
            message: "A valid subclass ID is required."
        }, 400);
    }

    const hasName = Object.prototype.hasOwnProperty.call(
        body,
        "subclass_name"
    );

    const hasStatus = Object.prototype.hasOwnProperty.call(
        body,
        "status"
    );

    if (!hasName && !hasStatus) {
        return json({
            success: false,
            message: "Provide a subclass name or status to update."
        }, 400);
    }

    const subclassName = hasName
        ? cleanSubclassName(body.subclass_name)
        : null;

    if (hasName && !subclassName) {
        return json({
            success: false,
            message: "Subclass name must contain 1 to 50 characters."
        }, 400);
    }

    if (
        hasStatus &&
        !["active", "inactive"].includes(body.status)
    ) {
        return json({
            success: false,
            message: "Invalid subclass status."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        const existingResult = await client.query(
            `
            SELECT
                id,
                school_id,
                academic_year_id,
                class_id,
                subclass_name,
                status
            FROM school_class_subclasses
            WHERE id = $1
              AND school_id = $2
            `,
            [subclassId, schoolId]
        );

        if (existingResult.rowCount === 0) {
            return json({
                success: false,
                message: "Subclass not found."
            }, 404);
        }

        const existing = existingResult.rows[0];

        const finalName = hasName
            ? subclassName
            : existing.subclass_name;

        const finalStatus = hasStatus
            ? body.status
            : existing.status;

        if (hasName) {
            const duplicateResult = await client.query(
                `
                SELECT id
                FROM school_class_subclasses
                WHERE school_id = $1
                  AND academic_year_id = $2
                  AND class_id = $3
                  AND LOWER(subclass_name) = LOWER($4)
                  AND id <> $5
                `,
                [
                    schoolId,
                    existing.academic_year_id,
                    existing.class_id,
                    finalName,
                    subclassId
                ]
            );

            if (duplicateResult.rowCount > 0) {
                return json({
                    success: false,
                    message: "Another subclass already uses this name."
                }, 409);
            }
        }

        const result = await client.query(
            `
            UPDATE school_class_subclasses
            SET
                subclass_name = $1,
                status = $2,
                updated_at = NOW()
            WHERE id = $3
              AND school_id = $4
            RETURNING
                id,
                academic_year_id,
                class_id,
                subclass_name,
                status,
                updated_at
            `,
            [
                finalName,
                finalStatus,
                subclassId,
                schoolId
            ]
        );

        return json({
            success: true,
            message: "Subclass updated successfully.",
            subclass: result.rows[0]
        });

    } catch (error) {
        console.error("Update subclass error:", {
            message: error?.message,
            code: error?.code
        });

        return json({
            success: false,
            message: "Failed to update subclass."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
