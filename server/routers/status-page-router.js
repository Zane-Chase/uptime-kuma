let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const Monitor = require("../model/monitor");
const { badgeConstants } = require("../../src/util");
const { makeBadge } = require("badge-maker");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

// Status page monitors API - returns all monitors with name, status, and uptime
router.get("/status/:slug/monitors", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status page not found");
            return;
        }

        // Get monitor ID list (reuse existing query logic)
        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        let monitors = [];

        for (let monitorID of monitorIDList) {
            // Get monitor name and latest heartbeat status
            let monitorData = await R.getRow(`
                SELECT m.name, h.status, h.ping
                FROM monitor m
                LEFT JOIN heartbeat h ON m.id = h.monitor_id
                WHERE m.id = ?
                ORDER BY h.time DESC
                LIMIT 1
            `, [
                monitorID
            ]);

            if (monitorData) {
                // Calculate 24-hour uptime
                const uptime = await Monitor.calcUptime(24, monitorID);
                
                monitors.push({
                    name: monitorData.name,
                    status: monitorData.status || 0, // Default to DOWN if no heartbeat
                    uptime: uptime,
                    responseTime: monitorData.ping || null // Add current response time
                });
            }
        }

        response.json({
            monitors: monitors
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [
            slug
        ]);

        if (!statusPage) {
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        if (!statusPageData) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json(statusPageData);

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        let statusPageID = await StatusPage.slugToID(slug);

        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        for (let monitorID of monitorIDList) {
            let list = await R.getAll(`
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 50
            `, [
                monitorID,
            ]);

            list = R.convertToBeans("heartbeat", list);
            heartbeatList[monitorID] = list.reverse().map(row => row.toPublicJSON());

            const type = 24;
            uptimeList[`${monitorID}_${type}`] = await Monitor.calcUptime(type, monitorID);
        }

        response.json({
            heartbeatList,
            uptimeList
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [
            slug
        ]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            "name": statusPage.title,
            "start_url": "/status/" + statusPage.slug,
            "display": "standalone",
            "icons": [
                {
                    "src": statusPage.icon,
                    "sizes": "128x128",
                    "type": "image/png"
                }
            ]
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    const slug = request.params.slug;
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle
    } = request.query;

    try {
        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(`
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `, [
                monitorID,
            ]);

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }

        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;

        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }

        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);

    } catch (error) {
        sendHttpError(response, error.message);
    }
});


module.exports = router;
