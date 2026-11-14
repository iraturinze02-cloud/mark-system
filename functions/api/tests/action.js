import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

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

/* =====================================================
   POST: TEST ACTIONS
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
            message: "You are not allowed to manage tests."
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

    const action = String(data.action || "").trim();

    const testId = String(
        data.testId || data.test_id || ""
    ).trim();

    if (!/^\d+$/.test(testId)) {
        return json({
            success: false,
            message: "Invalid test ID."
        }, 400);
    }

    const allowedActions = [
        "update",
        "initiate",
        "close",
        "delete"
    ];

    if (!allowedActions.includes(action)) {
        return json({
            success: false,
            message: "Invalid test action."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* ---------------------------------------------
           FIND TEST AND LOCK IT
        --------------------------------------------- */

        let testResult;

        if (auth.role === "sector_admin") {
            testResult = await client.query(
                `
                SELECT *
                FROM tests
                WHERE id = $1
                  AND sector_id = $2
                FOR UPDATE
                `,
                [testId, auth.sectorId]
            );

        } else {
            testResult = await client.query(
                `
                SELECT *
                FROM tests
                WHERE id = $1
                  AND school_id = $2
                FOR UPDATE
                `,
                [testId, auth.schoolId]
            );
        }

        if (testResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Test not found or you do not have permission to manage it."
            }, 404);
        }

        const test = testResult.rows[0];

        /* ---------------------------------------------
           DELETE TEST
           Only draft tests can be deleted.
        --------------------------------------------- */

        if (action === "delete") {
            if (test.status !== "draft") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only draft tests can be deleted."
                }, 400);
            }

            await client.query(
                `
                DELETE FROM tests
                WHERE id = $1
                `,
                [testId]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test deleted successfully."
            });
        }

        /* ---------------------------------------------
           INITIATE TEST
        --------------------------------------------- */

        if (action === "initiate") {
            if (test.status !== "draft") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only draft tests can be initiated."
                }, 400);
            }

            if (
                test.closing_at &&
                new Date(test.closing_at).getTime() <= Date.now()
            ) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The test closing time has already passed."
                }, 400);
            }

            await client.query(
                `
                UPDATE tests
                SET
                    status = 'open',
                    initiated_at = NOW(),
                    closed_at = NULL,
                    updated_at = NOW()
                WHERE id = $1
                `,
                [testId]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test initiated successfully. Teachers can now record marks."
            });
        }

        /* ---------------------------------------------
           CLOSE TEST
        --------------------------------------------- */

        if (action === "close") {
            if (test.status !== "open") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only open tests can be closed."
                }, 400);
            }

            await client.query(
                `
                UPDATE tests
                SET
                    status = 'closed',
                    closed_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                `,
                [testId]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test closed successfully."
            });
        }

        /* ---------------------------------------------
           UPDATE TEST
           Only draft tests can be edited.
        --------------------------------------------- */

        if (action === "update") {
            if (test.status !== "draft") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only draft tests can be edited."
                }, 400);
            }

            const testName = String(
                data.testName || data.test_name || ""
            ).trim();

            if (!testName || testName.length > 200) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Enter a valid test name."
                }, 400);
            }

            let schoolIds = uniqueIds(data.schoolIds);
            const classIds = uniqueIds(data.classIds);
            const subjectIds = uniqueIds(data.subjectIds);

            if (auth.role === "school_admin") {
                schoolIds = [String(auth.schoolId)];
            }

            if (
                schoolIds.length === 0 ||
                classIds.length === 0 ||
                subjectIds.length === 0
            ) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Select at least one school, class and subject."
                }, 400);
            }

            const closingAt = validClosingAt(
                data.closingAt ?? data.closing_at
            );

            if (closingAt === undefined) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The closing date and time must be in the future."
                }, 400);
            }

            /* -----------------------------------------
               VALIDATE SCHOOLS
            ----------------------------------------- */

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

            } else {
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

            /* -----------------------------------------
               VALIDATE CLASSES
            ----------------------------------------- */

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

            /* -----------------------------------------
               VALIDATE SUBJECTS
            ----------------------------------------- */

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

            /* -----------------------------------------
               UPDATE MAIN TEST
            ----------------------------------------- */

            await client.query(
                `
                UPDATE tests
                SET
                    test_name = $1,
                    closing_at = $2,
                    updated_at = NOW()
                WHERE id = $3
                `,
                [
                    testName,
                    closingAt,
                    testId
                ]
            );

            /* -----------------------------------------
               REMOVE OLD RELATIONSHIPS

               Deleting test_schools also removes
               related test_classes through ON DELETE
               CASCADE.
            ----------------------------------------- */

            await client.query(
                `
                DELETE FROM test_schools
                WHERE test_id = $1
                `,
                [testId]
            );

            await client.query(
                `
                DELETE FROM test_subjects
                WHERE test_id = $1
                `,
                [testId]
            );

            /* -----------------------------------------
               INSERT UPDATED SCHOOLS FIRST
            ----------------------------------------- */

            for (const schoolId of schoolIds) {
                await client.query(
                    `
                    INSERT INTO test_schools (
                        test_id,
                        school_id
                    )
                    VALUES ($1, $2)
                    `,
                    [testId, schoolId]
                );
            }

            /* -----------------------------------------
               INSERT UPDATED CLASSES
            ----------------------------------------- */

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
                        testId,
                        selectedClass.school_id,
                        selectedClass.id
                    ]
                );
            }

            /* -----------------------------------------
               INSERT UPDATED SUBJECTS
            ----------------------------------------- */

            for (const subjectId of subjectIds) {
                await client.query(
                    `
                    INSERT INTO test_subjects (
                        test_id,
                        subject_id
                    )
                    VALUES ($1, $2)
                    `,
                    [testId, subjectId]
                );
            }

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test updated successfully."
            });
        }

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Test action error:", error);

        return json({
            success: false,
            message: "Unable to complete the requested test action."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
