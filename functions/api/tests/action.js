
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

function getValue(data, snakeCase, camelCase) {
    return data[snakeCase] ?? data[camelCase];
}

/* =====================================================
   VALIDATE SUBJECT MAXIMUM MARKS
===================================================== */

function validateSubjectMarks(subjectIds, subjectMarks) {
    if (!Array.isArray(subjectMarks)) {
        return {
            valid: false,
            message: "Provide maximum marks for every selected subject."
        };
    }

    if (subjectMarks.length !== subjectIds.length) {
        return {
            valid: false,
            message: "Provide maximum marks for every selected subject."
        };
    }

    const marksMap = new Map();

    for (const item of subjectMarks) {
        if (!item || typeof item !== "object") {
            return {
                valid: false,
                message: "Invalid subject maximum marks data."
            };
        }

        const subjectId = String(
            item.subject_id ?? item.subjectId ?? ""
        ).trim();

        const totalMarks = Number(
            item.total_marks ?? item.totalMarks
        );

        if (!/^\d+$/.test(subjectId)) {
            return {
                valid: false,
                message: "Invalid subject selected."
            };
        }

        if (!subjectIds.includes(subjectId)) {
            return {
                valid: false,
                message: "Maximum marks were provided for an unselected subject."
            };
        }

        if (marksMap.has(subjectId)) {
            return {
                valid: false,
                message: "Duplicate subject maximum marks were provided."
            };
        }

        if (
            !Number.isFinite(totalMarks) ||
            totalMarks <= 0
        ) {
            return {
                valid: false,
                message: "Every subject must have a positive maximum mark."
            };
        }

        marksMap.set(subjectId, totalMarks);
    }

    for (const subjectId of subjectIds) {
        if (!marksMap.has(subjectId)) {
            return {
                valid: false,
                message: "Provide maximum marks for every selected subject."
            };
        }
    }

    return {
        valid: true,
        marks: subjectIds.map(subjectId => ({
            subject_id: subjectId,
            total_marks: marksMap.get(subjectId)
        }))
    };
}

/* =====================================================
   POST: TEST ACTIONS

   Supported actions:
   - update
   - initiate
   - close
   - delete

   Permissions are based on organizational scope.

   Sector admin:
   Manages Tests belonging to their sector.

   School admin:
   Manages Tests belonging to their school.
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireTestUser(context);

    if (auth.error) {
        return auth.error;
    }

    if (!["sector_admin", "school_admin"].includes(auth.role)) {
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
        data.testId ?? data.test_id ?? ""
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

           Authorization is based on the administrator's
           organizational scope, not who created it.
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
                [
                    testId,
                    auth.sectorId
                ]
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
                [
                    testId,
                    auth.schoolId
                ]
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

            const mappingResult = await client.query(
                `
                SELECT 1
                FROM test_examinations
                WHERE test_id = $1
                LIMIT 1
                `,
                [testId]
            );

            if (mappingResult.rows.length > 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This test is linked to an examination and cannot be deleted."
                }, 409);
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

           Only draft tests can be initiated.
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
                    initiated_by = $2,
                    closed_at = NULL,
                    closed_by = NULL,
                    updated_at = NOW()
                WHERE id = $1
                `,
                [
                    testId,
                    auth.userId
                ]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test initiated successfully. Teachers can now record marks.",
                initiated_by: auth.userId
            });
        }

        /* ---------------------------------------------
           CLOSE TEST

           Record the administrator who closed it.
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
                    closed_by = $2,
                    updated_at = NOW()
                WHERE id = $1
                `,
                [
                    testId,
                    auth.userId
                ]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test closed successfully.",
                closed_by: auth.userId
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

            /* -----------------------------------------
               READ TEST DETAILS
            ----------------------------------------- */

            const testName = String(
                getValue(data, "test_name", "testName") || ""
            ).trim();

            if (!testName || testName.length > 200) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Enter a valid test name."
                }, 400);
            }

            let schoolIds = uniqueIds(
                getValue(data, "school_ids", "schoolIds")
            );

            const classIds = uniqueIds(
                getValue(data, "class_ids", "classIds")
            );

            const subjectIds = uniqueIds(
                getValue(data, "subject_ids", "subjectIds")
            );

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

            /* -----------------------------------------
               VALIDATE SUBJECT MAXIMUM MARKS
            ----------------------------------------- */

            const subjectMarksValidation = validateSubjectMarks(
                subjectIds,
                getValue(data, "subject_marks", "subjectMarks")
            );

            if (!subjectMarksValidation.valid) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: subjectMarksValidation.message
                }, 400);
            }

            const subjectMarks = subjectMarksValidation.marks;

            /* -----------------------------------------
               VALIDATE CLOSING DATE
            ----------------------------------------- */

            const closingAt = validClosingAt(
                getValue(data, "closing_at", "closingAt")
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
                    [
                        schoolIds,
                        auth.sectorId
                    ]
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

               Every class must belong to one of the
               selected schools.
            ----------------------------------------- */

            const validClasses = await client.query(
                `
                SELECT id, school_id
                FROM classes
                WHERE id = ANY($1::bigint[])
                  AND school_id = ANY($2::bigint[])
                `,
                [
                    classIds,
                    schoolIds
                ]
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

               Removing test_schools also removes its
               dependent test_classes if the existing
               foreign key uses ON DELETE CASCADE.
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
                    [
                        testId,
                        schoolId
                    ]
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
               INSERT UPDATED SUBJECTS WITH MAXIMUM MARKS
            ----------------------------------------- */

            for (const subject of subjectMarks) {
                await client.query(
                    `
                    INSERT INTO test_subjects (
                        test_id,
                        subject_id,
                        total_marks
                    )
                    VALUES ($1, $2, $3)
                    `,
                    [
                        testId,
                        subject.subject_id,
                        subject.total_marks
                    ]
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
