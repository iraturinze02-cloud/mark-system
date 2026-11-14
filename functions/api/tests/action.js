
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

export async function onRequestPost(context) {
    const auth = await requireTestUser(context);
    if (auth.error) return auth.error;

    if (!["sector_admin", "school_admin"].includes(auth.role)) {
        return json({
            success: false,
            message: "Only administrators can manage tests."
        }, 403);
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({ success: false, message: "Invalid request." }, 400);
    }

    const testId = String(data.test_id || "");
    const action = String(data.action || "");

    if (!/^\d+$/.test(testId)) {
        return json({ success: false, message: "Invalid test ID." }, 400);
    }

    let client;

    try {
        client = await connectDB(context);
        await client.query("BEGIN");

        const scopeColumn = auth.role === "sector_admin"
            ? "sector_id"
            : "school_id";

        const scopeId = auth.role === "sector_admin"
            ? auth.sectorId
            : auth.schoolId;

        const testResult = await client.query(`
            SELECT *
            FROM tests
            WHERE id = $1
              AND ${scopeColumn} = $2
            FOR UPDATE
        `, [testId, scopeId]);

        const test = testResult.rows[0];

        if (!test) {
            throw new Error("Test not found or access denied.");
        }

        if (action === "delete") {
            if (test.status !== "draft") {
                throw new Error("Only tests that have not been initiated can be deleted.");
            }

            await client.query(
                "DELETE FROM tests WHERE id = $1",
                [testId]
            );

        } else if (action === "initiate") {
            if (test.status !== "draft") {
                throw new Error("Only draft tests can be initiated.");
            }

            if (test.closing_at && new Date(test.closing_at) <= new Date()) {
                throw new Error("The closing time has already passed.");
            }

            await client.query(`
                UPDATE tests
                SET status = 'open',
                    initiated_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
            `, [testId]);

        } else if (action === "close") {
            if (test.status !== "open") {
                throw new Error("Only open tests can be closed.");
            }

            await client.query(`
                UPDATE tests
                SET status = 'closed',
                    closed_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
            `, [testId]);

        } else if (action === "update") {
            if (test.status !== "draft") {
                throw new Error("Only draft tests can be edited.");
            }

            const name = String(data.test_name || "").trim();
            const schoolIds = [...new Set((data.school_ids || []).map(String))];
            const classIds = [...new Set((data.class_ids || []).map(String))];
            const subjectIds = [...new Set((data.subject_ids || []).map(String))];
            const closingAt = data.closing_at || null;

            if (!name || !classIds.length || !subjectIds.length) {
                throw new Error("Test name, classes and subjects are required.");
            }

            if (closingAt && (
                !Number.isFinite(Date.parse(closingAt)) ||
                new Date(closingAt) <= new Date()
            )) {
                throw new Error("Choose a valid future closing time.");
            }

            let selectedSchools;

            if (auth.role === "sector_admin") {
                if (!schoolIds.length) {
                    throw new Error("Select at least one school.");
                }

                const validSchools = await client.query(`
                    SELECT id
                    FROM schools
                    WHERE sector_id = $1
                      AND status = 'active'
                      AND id = ANY($2::bigint[])
                `, [auth.sectorId, schoolIds]);

                if (validSchools.rows.length !== schoolIds.length) {
                    throw new Error("A selected school is outside your sector.");
                }

                selectedSchools = validSchools.rows.map(r => String(r.id));
            } else {
                if (schoolIds.length) {
                    throw new Error("You cannot select other schools.");
                }
                selectedSchools = [auth.schoolId];
            }

            const validClasses = await client.query(`
                SELECT id, school_id
                FROM classes
                WHERE id = ANY($1::bigint[])
                  AND school_id = ANY($2::bigint[])
            `, [classIds, selectedSchools]);

            if (validClasses.rows.length !== classIds.length) {
                throw new Error("A selected class is outside the selected schools.");
            }

            const validSubjects = await client.query(`
                SELECT id FROM subjects
                WHERE id = ANY($1::bigint[])
            `, [subjectIds]);

            if (validSubjects.rows.length !== subjectIds.length) {
                throw new Error("A selected subject is invalid.");
            }

            await client.query(`
                UPDATE tests
                SET test_name = $1,
                    closing_at = $2,
                    updated_at = NOW()
                WHERE id = $3
            `, [name, closingAt, testId]);

            await client.query(
                "DELETE FROM test_classes WHERE test_id = $1",
                [testId]
            );
            await client.query(
                "DELETE FROM test_schools WHERE test_id = $1",
                [testId]
            );
            await client.query(
                "DELETE FROM test_subjects WHERE test_id = $1",
                [testId]
            );

            for (const schoolId of selectedSchools) {
                await client.query(`
                    INSERT INTO test_schools (test_id, school_id)
                    VALUES ($1, $2)
                `, [testId, schoolId]);
            }

            for (const item of validClasses.rows) {
                await client.query(`
                    INSERT INTO test_classes (test_id, school_id, class_id)
                    VALUES ($1, $2, $3)
                `, [testId, item.school_id, item.id]);
            }

            for (const subjectId of subjectIds) {
                await client.query(`
                    INSERT INTO test_subjects (test_id, subject_id)
                    VALUES ($1, $2)
                `, [testId, subjectId]);
            }

        } else {
            throw new Error("Unknown action.");
        }

        await client.query("COMMIT");

        return json({
            success: true,
            message: action === "initiate"
                ? "Test initiated successfully."
                : action === "close"
                    ? "Test closed successfully."
                    : action === "delete"
                        ? "Test deleted successfully."
                        : "Test updated successfully."
        });

    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});

        console.error("Test action error:", error);

        return json({
            success: false,
            message: error.message || "Unable to complete the action."
        }, 400);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
