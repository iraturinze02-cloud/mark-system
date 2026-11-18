import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

/* =====================================================
   FILA GRADES SYSTEM
   OWNER SUBJECTS & EDUCATION LEVELS API

   GET  /api/owner/subjects
   POST /api/owner/subjects

   Existing database structure is preserved.
===================================================== */

const LEVEL_ALIASES = {
    "primary": "Primary",
    "ordinary level": "Lower Secondary",
    "lower secondary": "Lower Secondary",
    "advanced level": "Upper Secondary",
    "upper secondary": "Upper Secondary"
};

function getMappingName(levelName) {
    const normalized = String(levelName || "")
        .trim()
        .toLowerCase();

    return LEVEL_ALIASES[normalized] || levelName;
}

function normalizeText(value) {
    return String(value || "").trim();
}

/* =====================================================
   GET — LOAD SUBJECTS, LEVELS AND ASSIGNMENTS
===================================================== */

export async function onRequestGet(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    let db;

    try {

        db = await connectDB(context);

        const subjectsResult = await db.query(`
            SELECT
                id,
                subject_name,
                subject_code,
                created_at
            FROM subjects
            ORDER BY subject_name ASC
        `);

        const levelsResult = await db.query(`
            SELECT
                id,
                level_name
            FROM education_levels
            ORDER BY id ASC
        `);

        const mappingsResult = await db.query(`
            SELECT
                id,
                subject_id,
                education_level
            FROM subject_class_levels
            ORDER BY id ASC
        `);

        const levels = levelsResult.rows;

        const subjects = subjectsResult.rows.map(subject => {

            const assignedMappings =
                mappingsResult.rows
                    .filter(mapping =>
                        String(mapping.subject_id) ===
                        String(subject.id)
                    )
                    .map(mapping =>
                        String(mapping.education_level)
                            .trim()
                            .toLowerCase()
                    );

            const assignedLevelIds = levels
                .filter(level => {
                    const mappingName = String(
                        getMappingName(level.level_name)
                    ).trim().toLowerCase();

                    return assignedMappings.includes(
                        mappingName
                    );
                })
                .map(level => String(level.id));

            return {
                ...subject,
                education_level_ids: assignedLevelIds
            };
        });

        return json({
            success: true,
            subjects,
            education_levels: levels,
            mappings: mappingsResult.rows
        });

    } catch (error) {

        console.error("OWNER SUBJECTS GET ERROR:", error);

        return json({
            success: false,
            message: "Failed to load subjects and education levels."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}

/* =====================================================
   POST — OWNER ACTIONS
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    let db;
    let transactionStarted = false;

    try {

        const body = await context.request.json();

        const action = normalizeText(body.action);

        db = await connectDB(context);

        /* =================================================
           ADD SUBJECT
        ================================================= */

        if (action === "add_subject") {

            const subjectName = normalizeText(
                body.subject_name
            );

            const subjectCode = normalizeText(
                body.subject_code
            ).toUpperCase();

            if (!subjectName || !subjectCode) {
                return json({
                    success: false,
                    message: "Subject name and subject code are required."
                }, 400);
            }

            if (subjectName.length > 150) {
                return json({
                    success: false,
                    message: "Subject name is too long."
                }, 400);
            }

            if (subjectCode.length > 50) {
                return json({
                    success: false,
                    message: "Subject code is too long."
                }, 400);
            }

            const duplicateName = await db.query(`
                SELECT id
                FROM subjects
                WHERE LOWER(TRIM(subject_name)) =
                      LOWER(TRIM($1))
                LIMIT 1
            `, [subjectName]);

            if (duplicateName.rows.length) {
                return json({
                    success: false,
                    message: "This subject already exists."
                }, 409);
            }

            const duplicateCode = await db.query(`
                SELECT id
                FROM subjects
                WHERE UPPER(TRIM(subject_code)) =
                      UPPER(TRIM($1))
                LIMIT 1
            `, [subjectCode]);

            if (duplicateCode.rows.length) {
                return json({
                    success: false,
                    message: "This subject code is already in use."
                }, 409);
            }

            const result = await db.query(`
                INSERT INTO subjects (
                    subject_name,
                    subject_code
                )
                VALUES ($1, $2)
                RETURNING
                    id,
                    subject_name,
                    subject_code,
                    created_at
            `, [
                subjectName,
                subjectCode
            ]);

            return json({
                success: true,
                message: "Subject added successfully.",
                subject: result.rows[0]
            }, 201);
        }

        /* =================================================
           ADD EDUCATION LEVEL
        ================================================= */

        if (action === "add_level") {

            const levelName = normalizeText(
                body.level_name
            );

            if (!levelName) {
                return json({
                    success: false,
                    message: "Education level name is required."
                }, 400);
            }

            const duplicate = await db.query(`
                SELECT id
                FROM education_levels
                WHERE LOWER(TRIM(level_name)) =
                      LOWER(TRIM($1))
                LIMIT 1
            `, [levelName]);

            if (duplicate.rows.length) {
                return json({
                    success: false,
                    message: "This education level already exists."
                }, 409);
            }

            /*
               Existing table has no ID default.

               Use a transaction and advisory lock to
               safely allocate the next ID.
            */

            await db.query("BEGIN");
            transactionStarted = true;

            await db.query(`
                SELECT pg_advisory_xact_lock(741852963)
            `);

            const nextIdResult = await db.query(`
                SELECT COALESCE(MAX(id), 0) + 1 AS next_id
                FROM education_levels
            `);

            const nextId = nextIdResult.rows[0].next_id;

            const result = await db.query(`
                INSERT INTO education_levels (
                    id,
                    level_name
                )
                VALUES ($1, $2)
                RETURNING id, level_name
            `, [
                nextId,
                levelName
            ]);

            await db.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Education level added successfully.",
                level: result.rows[0]
            }, 201);
        }

        /* =================================================
           ASSIGN SUBJECT TO EDUCATION LEVELS
        ================================================= */

        if (action === "assign_levels") {

            const subjectId = Number(body.subject_id);

            const selectedLevelIds = Array.isArray(
                body.education_level_ids
            )
                ? body.education_level_ids
                    .map(Number)
                    .filter(id =>
                        Number.isInteger(id) && id > 0
                    )
                : [];

            if (
                !Number.isInteger(subjectId) ||
                subjectId <= 0
            ) {
                return json({
                    success: false,
                    message: "Invalid subject."
                }, 400);
            }

            await db.query("BEGIN");
            transactionStarted = true;

            await db.query(`
                SELECT pg_advisory_xact_lock(741852964)
            `);

            const subjectCheck = await db.query(`
                SELECT id
                FROM subjects
                WHERE id = $1
                LIMIT 1
            `, [subjectId]);

            if (!subjectCheck.rows.length) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Subject not found."
                }, 404);
            }

            let selectedLevels = [];

            if (selectedLevelIds.length > 0) {

                const levelResult = await db.query(`
                    SELECT id, level_name
                    FROM education_levels
                    WHERE id = ANY($1::bigint[])
                `, [selectedLevelIds]);

                if (
                    levelResult.rows.length !==
                    selectedLevelIds.length
                ) {

                    await db.query("ROLLBACK");
                    transactionStarted = false;

                    return json({
                        success: false,
                        message: "One or more education levels were not found."
                    }, 400);
                }

                selectedLevels = levelResult.rows;
            }

            /*
               Replace mappings for this subject only.

               Other subjects are not touched.
            */

            await db.query(`
                DELETE FROM subject_class_levels
                WHERE subject_id = $1
            `, [subjectId]);

            if (selectedLevels.length > 0) {

                await db.query(`
                    SELECT pg_advisory_xact_lock(741852965)
                `);

                const idResult = await db.query(`
                    SELECT COALESCE(MAX(id), 0) AS max_id
                    FROM subject_class_levels
                `);

                let nextMappingId =
                    Number(idResult.rows[0].max_id) + 1;

                for (const level of selectedLevels) {

                    const mappingName = getMappingName(
                        level.level_name
                    );

                    await db.query(`
                        INSERT INTO subject_class_levels (
                            id,
                            subject_id,
                            education_level
                        )
                        VALUES ($1, $2, $3)
                    `, [
                        nextMappingId,
                        subjectId,
                        mappingName
                    ]);

                    nextMappingId++;
                }
            }

            await db.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Subject education levels updated successfully."
            });
        }

        /* =================================================
           DELETE SUBJECT

           Prevent deletion if referenced by existing
           examinations, marks, tests or assignments.
        ================================================= */

        if (action === "delete_subject") {

            const subjectId = Number(body.subject_id);

            if (
                !Number.isInteger(subjectId) ||
                subjectId <= 0
            ) {
                return json({
                    success: false,
                    message: "Invalid subject."
                }, 400);
            }

            await db.query("BEGIN");
            transactionStarted = true;

            const subjectCheck = await db.query(`
                SELECT id, subject_name
                FROM subjects
                WHERE id = $1
                FOR UPDATE
            `, [subjectId]);

            if (!subjectCheck.rows.length) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Subject not found."
                }, 404);
            }

            /*
               Check known tables that store subject_id.

               If any existing record references the
               subject, deletion is refused.
            */

            const referenceTables = [
                "examinations",
                "marks",
                "teacher_assignments",
                "test_subjects"
            ];

            for (const tableName of referenceTables) {

                const tableCheck = await db.query(`
                    SELECT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = $1
                          AND column_name = 'subject_id'
                    ) AS exists
                `, [tableName]);

                if (!tableCheck.rows[0].exists) {
                    continue;
                }

                const referenceResult = await db.query(`
                    SELECT 1
                    FROM ${tableName}
                    WHERE subject_id = $1
                    LIMIT 1
                `, [subjectId]);

                if (referenceResult.rows.length > 0) {

                    await db.query("ROLLBACK");
                    transactionStarted = false;

                    return json({
                        success: false,
                        message:
                            `This subject cannot be deleted because it is already used in ${tableName}.`
                    }, 409);
                }
            }

            await db.query(`
                DELETE FROM subject_class_levels
                WHERE subject_id = $1
            `, [subjectId]);

            await db.query(`
                DELETE FROM subjects
                WHERE id = $1
            `, [subjectId]);

            await db.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Subject deleted successfully."
            });
        }

        /* =================================================
           DELETE EDUCATION LEVEL

           Prevent deletion when referenced by:
           - subject_class_levels
           - school_levels
           - classes
        ================================================= */

        if (action === "delete_level") {

            const levelId = Number(body.level_id);

            if (
                !Number.isInteger(levelId) ||
                levelId <= 0
            ) {
                return json({
                    success: false,
                    message: "Invalid education level."
                }, 400);
            }

            await db.query("BEGIN");
            transactionStarted = true;

            const levelResult = await db.query(`
                SELECT id, level_name
                FROM education_levels
                WHERE id = $1
                FOR UPDATE
            `, [levelId]);

            if (!levelResult.rows.length) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Education level not found."
                }, 404);
            }

            const levelName =
                levelResult.rows[0].level_name;

            const mappingName =
                getMappingName(levelName);

            const mappingCheck = await db.query(`
                SELECT 1
                FROM subject_class_levels
                WHERE LOWER(TRIM(education_level)) =
                      LOWER(TRIM($1))
                LIMIT 1
            `, [mappingName]);

            if (mappingCheck.rows.length > 0) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This education level is assigned to subjects. Remove its subject assignments before deleting it."
                }, 409);
            }

            /*
               Check known references by level_id.
            */

            for (const tableName of [
                "school_levels",
                "classes"
            ]) {

                const columnCheck = await db.query(`
                    SELECT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = $1
                          AND column_name = 'level_id'
                    ) AS exists
                `, [tableName]);

                if (!columnCheck.rows[0].exists) {
                    continue;
                }

                const referenceCheck = await db.query(`
                    SELECT 1
                    FROM ${tableName}
                    WHERE level_id = $1
                    LIMIT 1
                `, [levelId]);

                if (referenceCheck.rows.length > 0) {

                    await db.query("ROLLBACK");
                    transactionStarted = false;

                    return json({
                        success: false,
                        message: `This education level cannot be deleted because it is used by ${tableName}.`
                    }, 409);
                }
            }

            await db.query(`
                DELETE FROM education_levels
                WHERE id = $1
            `, [levelId]);

            await db.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Education level deleted successfully."
            });
        }

        return json({
            success: false,
            message: "Invalid action."
        }, 400);

    } catch (error) {

        if (db && transactionStarted) {
            await db.query("ROLLBACK").catch(() => {});
        }

        console.error("OWNER SUBJECTS POST ERROR:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "A duplicate record already exists."
            }, 409);
        }

        return json({
            success: false,
            message: "The operation failed. No successful changes were confirmed."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}
