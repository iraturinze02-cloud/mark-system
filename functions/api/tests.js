
import {
    connectDB,
    requireTestUser,
    json
} from "../_utils.js";

/* =====================================================
   HELPERS
===================================================== */

function uniqueIds(values) {
    if (!Array.isArray(values)) return [];

    return [
        ...new Set(
            values
                .map(value => String(value).trim())
                .filter(value => /^\d+$/.test(value))
        )
    ];
}

function validClosingAt(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    if (date.getTime() <= Date.now()) {
        return undefined;
    }

    return date.toISOString();
}

async function closeExpiredTests(client) {
    await client.query(`
        UPDATE tests
        SET
            status = 'closed',
            closed_at = NOW(),
            updated_at = NOW()
        WHERE status = 'open'
          AND closing_at IS NOT NULL
          AND closing_at <= NOW()
    `);
}

/* =====================================================
   GET: LOAD TESTS
===================================================== */

export async function onRequestGet(context) {
    const auth = await requireTestUser(context);

    if (auth.error) {
        return auth.error;
    }

    let client;

    try {
        client = await connectDB(context);

        await closeExpiredTests(client);

        let visibilityCondition = "";
        let parameters = [];

        /* ---------------------------------------------
           SECTOR ADMIN VISIBILITY
        --------------------------------------------- */

        if (auth.role === "sector_admin") {
            visibilityCondition = `
                t.sector_id = $1
            `;

            parameters = [auth.sectorId];
        }

        /* ---------------------------------------------
           SCHOOL ADMIN VISIBILITY

           Own school tests and sector tests assigned
           to their school.
        --------------------------------------------- */

        else if (auth.role === "school_admin") {
            visibilityCondition = `
                (
                    t.school_id = $1

                    OR EXISTS (
                        SELECT 1
                        FROM test_schools ts
                        WHERE ts.test_id = t.id
                          AND ts.school_id = $1
                    )
                )
            `;

            parameters = [auth.schoolId];
        }

        /* ---------------------------------------------
           TEACHER VISIBILITY

           A teacher must have an assignment matching
           the test's school, class and subject.
        --------------------------------------------- */

        else if (auth.role === "teacher") {
            visibilityCondition = `
                EXISTS (
                    SELECT 1
                    FROM teachers tr

                    INNER JOIN teacher_assignments ta
                        ON ta.teacher_id = tr.id
                       AND ta.school_id = tr.school_id

                    INNER JOIN test_classes tc
                        ON tc.test_id = t.id
                       AND tc.class_id = ta.class_id
                       AND tc.school_id = ta.school_id

                    INNER JOIN test_subjects tsu
                        ON tsu.test_id = t.id
                       AND tsu.subject_id = ta.subject_id

                    WHERE tr.user_id = $1
                      AND tr.school_id = tc.school_id
                )
            `;

            parameters = [auth.userId];
        }

        else {
            return json({
                success: false,
                message: "Not authorized."
            }, 403);
        }

        /* ---------------------------------------------
           LOAD TESTS WITH RELATED DATA

           The HTML expects:
           schools[]
           classes[]
           subjects[]
           creator_name
           can_manage
        --------------------------------------------- */

        const testsResult = await client.query(
            `
            SELECT
                t.id,
                t.test_name,
                t.sector_id,
                t.school_id,
                t.created_by,
                t.status,
                t.closing_at,
                t.initiated_at,
                t.closed_at,
                t.created_at,
                t.updated_at,

                creator.full_name AS creator_name,

                CASE
                    WHEN $${parameters.length + 1} = 'sector_admin'
                         AND t.sector_id = $${parameters.length + 2}
                    THEN TRUE

                    WHEN $${parameters.length + 1} = 'school_admin'
                         AND t.school_id = $${parameters.length + 2}
                    THEN TRUE

                    ELSE FALSE
                END AS can_manage,

                COALESCE(
                    test_schools.data,
                    '[]'::json
                ) AS schools,

                COALESCE(
                    test_classes.data,
                    '[]'::json
                ) AS classes,

                COALESCE(
                    test_subjects.data,
                    '[]'::json
                ) AS subjects

            FROM tests t

            LEFT JOIN users creator
                ON creator.id = t.created_by

            LEFT JOIN LATERAL (
                SELECT json_agg(
                    json_build_object(
                        'id', s.id,
                        'school_name', s.school_name
                    )
                    ORDER BY s.school_name
                ) AS data
                FROM test_schools ts
                INNER JOIN schools s
                    ON s.id = ts.school_id
                WHERE ts.test_id = t.id
            ) test_schools ON TRUE

            LEFT JOIN LATERAL (
                SELECT json_agg(
                    json_build_object(
                        'id', c.id,
                        'class_name', c.class_name,
                        'class_level', c.class_level,
                        'school_id', c.school_id
                    )
                    ORDER BY c.class_name
                ) AS data
                FROM test_classes tc
                INNER JOIN classes c
                    ON c.id = tc.class_id
                   AND c.school_id = tc.school_id
                WHERE tc.test_id = t.id
            ) test_classes ON TRUE

            LEFT JOIN LATERAL (
                SELECT json_agg(
                    json_build_object(
                        'id', s.id,
                        'subject_name', s.subject_name,
                        'subject_code', s.subject_code
                    )
                    ORDER BY s.subject_name
                ) AS data
                FROM test_subjects ts
                INNER JOIN subjects s
                    ON s.id = ts.subject_id
                WHERE ts.test_id = t.id
            ) test_subjects ON TRUE

            WHERE ${visibilityCondition}

            ORDER BY t.created_at DESC
            `,
            [
                ...parameters,
                auth.role,
                auth.role === "sector_admin"
                    ? auth.sectorId
                    : auth.schoolId
            ]
        );

        /* ---------------------------------------------
           LOAD SCHOOLS FOR TEST FORM
        --------------------------------------------- */

        let schools = [];

        if (auth.role === "sector_admin") {
            const result = await client.query(
                `
                SELECT
                    id,
                    school_name,
                    school_code
                FROM schools
                WHERE sector_id = $1
                  AND status = 'active'
                ORDER BY school_name
                `,
                [auth.sectorId]
            );

            schools = result.rows;
        }

        else if (auth.role === "school_admin") {
            const result = await client.query(
                `
                SELECT
                    id,
                    school_name,
                    school_code
                FROM schools
                WHERE id = $1
                  AND status = 'active'
                `,
                [auth.schoolId]
            );

            schools = result.rows;
        }

        /* ---------------------------------------------
           LOAD CLASSES FOR TEST FORM
        --------------------------------------------- */

        let classes = [];

        if (auth.role === "sector_admin") {
            const result = await client.query(
                `
                SELECT
                    c.id,
                    c.class_name,
                    c.class_level,
                    c.school_id,
                    s.school_name
                FROM classes c
                INNER JOIN schools s
                    ON s.id = c.school_id
                WHERE s.sector_id = $1
                  AND s.status = 'active'
                ORDER BY s.school_name, c.class_name
                `,
                [auth.sectorId]
            );

            classes = result.rows;
        }

        else if (auth.role === "school_admin") {
            const result = await client.query(
                `
                SELECT
                    id,
                    class_name,
                    class_level,
                    school_id
                FROM classes
                WHERE school_id = $1
                ORDER BY class_name
                `,
                [auth.schoolId]
            );

            classes = result.rows;
        }

        else if (auth.role === "teacher") {
            const result = await client.query(
                `
                SELECT DISTINCT
                    c.id,
                    c.class_name,
                    c.class_level,
                    c.school_id
                FROM teachers tr
                INNER JOIN teacher_assignments ta
                    ON ta.teacher_id = tr.id
                   AND ta.school_id = tr.school_id
                INNER JOIN classes c
                    ON c.id = ta.class_id
                   AND c.school_id = ta.school_id
                WHERE tr.user_id = $1
                ORDER BY c.class_name
                `,
                [auth.userId]
            );

            classes = result.rows;
        }

        /* ---------------------------------------------
           LOAD SUBJECTS
        --------------------------------------------- */

        const subjectsResult = await client.query(`
            SELECT
                id,
                subject_name,
                subject_code
            FROM subjects
            ORDER BY subject_name
        `);

        return json({
            success: true,
            tests: testsResult.rows,
            schools,
            classes,
            subjects: subjectsResult.rows,

            user: {
                id: auth.userId,
                role: auth.role,
                sectorId: auth.sectorId,
                schoolId: auth.schoolId
            }
        });

    } catch (error) {
        console.error("Load tests error:", error);

        return json({
            success: false,
            message: "Unable to load tests."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}

/* =====================================================
   POST: CREATE A TEST
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireTestUser(context);

    if (auth.error) {
        return auth.error;
    }

    if (
        auth.role !== "sector_admin" &&
        auth.role !== "school_admin"
    ) {
        return json({
            success: false,
            message: "Teachers cannot create tests."
        }, 403);
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    /* ---------------------------------------------
       READ BOTH SNAKE_CASE AND CAMELCASE
    --------------------------------------------- */

    const testName = String(
        data.test_name ?? data.testName ?? ""
    ).trim();

    if (!testName || testName.length > 200) {
        return json({
            success: false,
            message: "Enter a valid test name."
        }, 400);
    }

    let schoolIds;

    if (auth.role === "school_admin") {
        // School Admin always uses their own school.
        // The frontend does not need to send school_ids.
        schoolIds = [String(auth.schoolId)];
    } else {
        schoolIds = uniqueIds(
            data.school_ids ?? data.schoolIds
        );
    }

    const classIds = uniqueIds(
        data.class_ids ?? data.classIds
    );

    const subjectIds = uniqueIds(
        data.subject_ids ?? data.subjectIds
    );

    if (schoolIds.length === 0) {
        return json({
            success: false,
            message: "Select at least one school."
        }, 400);
    }

    if (classIds.length === 0) {
        return json({
            success: false,
            message: "Select at least one class."
        }, 400);
    }

    if (subjectIds.length === 0) {
        return json({
            success: false,
            message: "Select at least one subject."
        }, 400);
    }

    const closingAt = validClosingAt(
        data.closing_at ?? data.closingAt
    );

    if (closingAt === undefined) {
        return json({
            success: false,
            message: "The closing date and time must be in the future."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* ---------------------------------------------
           VALIDATE SELECTED SCHOOLS
        --------------------------------------------- */

        let validSchools;

        if (auth.role === "sector_admin") {
            validSchools = await client.query(
                `
                SELECT id
                FROM schools
                WHERE id = ANY($1::bigint[])
                  AND sector_id = $2
                  AND status = 'active'
                `,
                [schoolIds, auth.sectorId]
            );
        }

        else {
            validSchools = await client.query(
                `
                SELECT id
                FROM schools
                WHERE id = $1
                  AND status = 'active'
                `,
                [auth.schoolId]
            );
        }

        if (validSchools.rows.length !== schoolIds.length) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "One or more selected schools are invalid."
            }, 400);
        }

        /* ---------------------------------------------
           VALIDATE CLASSES
        --------------------------------------------- */

        const validClasses = await client.query(
            `
            SELECT id, school_id
            FROM classes
            WHERE id = ANY($1::bigint[])
              AND school_id = ANY($2::bigint[])
            `,
            [classIds, schoolIds]
        );

        if (validClasses.rows.length !== classIds.length) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "One or more selected classes do not belong to the selected schools."
            }, 400);
        }

        /* ---------------------------------------------
           VALIDATE SUBJECTS
        --------------------------------------------- */

        const validSubjects = await client.query(
            `
            SELECT id
            FROM subjects
            WHERE id = ANY($1::bigint[])
            `,
            [subjectIds]
        );

        if (validSubjects.rows.length !== subjectIds.length) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "One or more selected subjects are invalid."
            }, 400);
        }

        /* ---------------------------------------------
           CREATE TEST
        --------------------------------------------- */

        const testResult = await client.query(
            `
            INSERT INTO tests (
                test_name,
                sector_id,
                school_id,
                created_by,
                status,
                closing_at
            )
            VALUES ($1, $2, $3, $4, 'draft', $5)
            RETURNING *
            `,
            [
                testName,
                auth.role === "sector_admin"
                    ? auth.sectorId
                    : null,
                auth.role === "school_admin"
                    ? auth.schoolId
                    : null,
                auth.userId,
                closingAt
            ]
        );

        const test = testResult.rows[0];

        /* ---------------------------------------------
           INSERT TEST SCHOOLS FIRST

           Required by the composite foreign key
           in test_classes.
        --------------------------------------------- */

        for (const schoolId of schoolIds) {
            await client.query(
                `
                INSERT INTO test_schools (
                    test_id,
                    school_id
                )
                VALUES ($1, $2)
                `,
                [test.id, schoolId]
            );
        }

        /* ---------------------------------------------
           INSERT TEST CLASSES
        --------------------------------------------- */

        for (const selectedClass of validClasses.rows) {
            await client.query(
                `
                INSERT INTO test_classes (
                    test_id,
                    school_id,
                    class_id
                )
                VALUES ($1, $2, $3)
                `,
                [
                    test.id,
                    selectedClass.school_id,
                    selectedClass.id
                ]
            );
        }

        /* ---------------------------------------------
           INSERT TEST SUBJECTS
        --------------------------------------------- */

        for (const subjectId of subjectIds) {
            await client.query(
                `
                INSERT INTO test_subjects (
                    test_id,
                    subject_id
                )
                VALUES ($1, $2)
                `,
                [test.id, subjectId]
            );
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Test created successfully.",
            test
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Create test error:", error);

        return json({
            success: false,
            message: "Unable to create the test."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
