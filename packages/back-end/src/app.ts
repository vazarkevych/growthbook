import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import express, { RequestHandler, ErrorRequestHandler } from "express";
import "./util/logger";
import mongoInit from "./init/mongo";
import cors from "cors";
import { AuthRequest } from "./types/AuthRequest";
import { APP_ORIGIN, CORS_ORIGIN_REGEX, IS_CLOUD } from "./util/secrets";
import {
  getExperimentConfig,
  getVisualDesignerScript,
} from "./controllers/config";
import asyncHandler from "express-async-handler";
import pino from "pino-http";
import { verifySlackRequestSignature } from "./services/slack";
import { getJWTCheck, processJWT } from "./services/auth";

// Controllers
import * as authController from "./controllers/auth";
import * as organizationsController from "./controllers/organizations";
import * as experimentsController from "./controllers/experiments";
import * as learningsController from "./controllers/learnings";
import * as ideasController from "./controllers/ideas";
import * as presentationController from "./controllers/presentations";
import * as discussionsController from "./controllers/discussions";
import * as adminController from "./controllers/admin";
import * as stripeController from "./controllers/stripe";
import * as segmentsController from "./controllers/segments";
import * as dimensionsController from "./controllers/dimensions";
import * as slackController from "./controllers/slack";

// Wrap every controller function in asyncHandler to catch errors properly
function wrapController(controller: Record<string, RequestHandler>): void {
  Object.keys(controller).forEach((key) => {
    if (typeof controller[key] === "function") {
      controller[key] = asyncHandler(controller[key]);
    }
  });
}
wrapController(authController);
wrapController(organizationsController);
wrapController(experimentsController);
wrapController(learningsController);
wrapController(ideasController);
wrapController(presentationController);
wrapController(discussionsController);
wrapController(adminController);
wrapController(stripeController);
wrapController(segmentsController);
wrapController(dimensionsController);
wrapController(slackController);

const app = express();

app.set("port", process.env.PORT || 3100);
app.use(cookieParser());

// Health check route (does not require JWT or cors)
app.get("/healthcheck", (req, res) => {
  // TODO: more robust health check?
  res.status(200).json({
    status: 200,
    healthy: true,
  });
});

// Visual Designer js file (does not require JWT or cors)
app.get("/visual-designer.js", getVisualDesignerScript);

const loggerRedact = {
  paths: [
    "req.headers.authorization",
    'req.headers["if-none-match"]',
    'req.headers["cache-control"]',
    'req.headers["upgrade-insecure-requests"]',
    "req.headers.cookie",
    "req.headers.connection",
    'req.headers["accept"]',
    'req.headers["accept-encoding"]',
    'req.headers["accept-language"]',
    'req.headers["sec-fetch-site"]',
    'req.headers["sec-fetch-mode"]',
    'req.headers["sec-fetch-dest"]',
    "res.headers.etag",
    'res.headers["x-powered-by"]',
    'res.headers["access-control-allow-credentials"]',
    'res.headers["access-control-allow-origin"]',
  ],
  remove: true,
};
const preAuthLogger = pino({
  redact: loggerRedact,
});

// Stripe webhook (needs raw body)
app.post(
  "/stripe/webhook",
  bodyParser.raw({
    type: "application/json",
  }),
  preAuthLogger,
  stripeController.postWebhook
);

// Slack app (body is urlencoded)
app.post(
  "/ideas/slack",
  bodyParser.urlencoded({
    extended: true,
    verify: verifySlackRequestSignature,
  }),
  preAuthLogger,
  slackController.postIdeas
);

app.use(bodyParser.json());

export async function init() {
  await mongoInit();
}

// Config route (does not require JWT, does require cors with origin = *)
app.get(
  "/config/:key",
  cors({
    credentials: false,
    origin: "*",
  }),
  preAuthLogger,
  getExperimentConfig
);

// Accept cross-origin requests from the frontend app
const origins: (string | RegExp)[] = [APP_ORIGIN];
if (CORS_ORIGIN_REGEX) {
  origins.push(CORS_ORIGIN_REGEX);
}
app.use(
  cors({
    credentials: true,
    origin: origins,
  })
);

// Pre-auth requests
// Managed cloud deployment uses Auth0 instead
if (!IS_CLOUD) {
  app.post("/auth/refresh", preAuthLogger, authController.postRefresh);
  app.post("/auth/login", preAuthLogger, authController.postLogin);
  app.post("/auth/logout", preAuthLogger, authController.postLogout);
  app.post("/auth/register", preAuthLogger, authController.postRegister);
  app.post("/auth/forgot", preAuthLogger, authController.postForgotPassword);
  app.get("/auth/reset/:token", preAuthLogger, authController.getResetPassword);
  app.post(
    "/auth/reset/:token",
    preAuthLogger,
    authController.postResetPassword
  );
}

// All other routes require a valid JWT
app.use(getJWTCheck());

// Add logged in user props to the request
app.use(processJWT);

const logger = pino({
  autoLogging: process.env.NODE_ENV === "production",
  redact: loggerRedact,
  reqCustomProps: (req: AuthRequest) => ({
    userId: req.userId,
    admin: !!req.admin,
  }),
});

app.use(logger);

// Event Tracking
//app.get("/events", eventsController.getEvents);
//app.post("/events/sync", eventsController.postEventsSync);

// Logged-in auth requests
// Managed cloud deployment uses Auth0 instead
if (!IS_CLOUD) {
  app.post("/auth/change-password", authController.postChangePassword);
}

// Organizations
app.get("/user", organizationsController.getUser);

// Every other route requires a userId to be set
app.use(
  asyncHandler(async (req: AuthRequest, res, next) => {
    if (!req.userId) {
      throw new Error("Must be authenticated.  Try refreshing the page.");
    }
    next();
  })
);

// Organization and Settings
app.put("/user/name", organizationsController.putUserName);
app.get("/user/watching", organizationsController.getWatchedExperiments);
app.get("/activity", organizationsController.getActivityFeed);
app.get("/history/:type/:id", organizationsController.getHistory);
app.get("/organization", organizationsController.getOrganization);
app.post("/organization", organizationsController.signup);
app.put("/organization", organizationsController.putOrganization);
app.post("/invite/accept", organizationsController.postInviteAccept);
app.post("/invite", organizationsController.postInvite);
app.post("/invite/resend", organizationsController.postInviteResend);
app.delete("/invite", organizationsController.deleteInvite);
app.get("/members", organizationsController.getUsers);
app.delete("/member/:id", organizationsController.deleteMember);
app.put("/member/:id/role", organizationsController.putMemberRole);
app.get("/tags", organizationsController.getTags);
app.post("/oauth/google", organizationsController.postGoogleOauthRedirect);
app.post("/subscription/start", stripeController.postStartTrial);
app.post("/subscription/manage", stripeController.postCreateBillingSession);
app.get("/queries/:ids", organizationsController.getQueries);

// Learnings
app.get("/learnings", learningsController.getLearnings);
app.post("/learnings", learningsController.postLearnings);
app.get("/learning/:id", learningsController.getLearning);
app.post("/learning/:id", learningsController.postLearning);
app.delete("/learning/:id", learningsController.deleteLearning);
app.post("/learning/:id/vote", learningsController.postVote);

// Ideas
app.get("/ideas", ideasController.getIdeas);
app.post("/ideas", ideasController.postIdeas);
app.get("/idea/:id", ideasController.getIdea);
app.post("/idea/:id", ideasController.postIdea);
app.delete("/idea/:id", ideasController.deleteIdea);
app.post("/idea/:id/vote", ideasController.postVote);
app.post("/ideas/impact", ideasController.getEstimatedImpact);
app.post("/ideas/estimate/manual", ideasController.postEstimatedImpactManual);

// Metrics
app.get("/metrics", experimentsController.getMetrics);
app.post("/metrics", experimentsController.postMetrics);
app.get("/metric/:id", experimentsController.getMetric);
app.put("/metric/:id", experimentsController.putMetric);
app.delete("/metric/:id", experimentsController.deleteMetric);
app.post("/metric/:id/analysis", experimentsController.postMetricAnalysis);
app.get(
  "/metric/:id/analysis/status",
  experimentsController.getMetricAnalysisStatus
);
app.post(
  "/metric/:id/analysis/cancel",
  experimentsController.cancelMetricAnalysis
);

// Experiments
app.get("/experiments", experimentsController.getExperiments);
app.post("/experiments", experimentsController.postExperiments);
app.get(
  "/experiments/frequency/month/:num",
  experimentsController.getExperimentsFrequencyMonth
);
app.get("/experiment/:id", experimentsController.getExperiment);
app.get("/experiment/:id/snapshot/:phase", experimentsController.getSnapshot);
app.get(
  "/experiment/:id/snapshot/:phase/:dimension",
  experimentsController.getSnapshotWithDimension
);
app.post("/experiment/:id/snapshot", experimentsController.postSnapshot);
app.post(
  "/experiment/:id/snapshot/:phase/preview",
  experimentsController.previewManualSnapshot
);
app.post("/experiment/:id", experimentsController.postExperiment);
app.delete("/experiment/:id", experimentsController.deleteExperiment);
app.post("/experiment/:id/watch", experimentsController.watchExperiment);
app.post("/experiment/:id/unwatch", experimentsController.unwatchExperiment);
app.post("/experiment/:id/phase", experimentsController.postExperimentPhase);
app.post("/experiment/:id/stop", experimentsController.postExperimentStop);
app.post(
  "/experiment/:id/upload/:filetype",
  experimentsController.postScreenshotUploadUrl
);
app.put(
  "/experiment/:id/variation/:variation/screenshot",
  experimentsController.addScreenshot
);
app.delete(
  "/experiment/:id/variation/:variation/screenshot",
  experimentsController.deleteScreenshot
);
app.post(
  "/experiment/:id/archive",
  experimentsController.postExperimentArchive
);
app.post(
  "/experiment/:id/unarchive",
  experimentsController.postExperimentUnarchive
);
app.post("/experiments/import", experimentsController.postPastExperiments);
app.get(
  "/experiments/import/:id",
  experimentsController.getPastExperimentsList
);
app.get(
  "/experiments/import/:id/status",
  experimentsController.getPastExperimentStatus
);
app.post(
  "/experiments/import/:id/cancel",
  experimentsController.cancelPastExperiments
);

// Segments and Segment Comparisons
app.get("/segments", segmentsController.getAllSegments);
app.post("/segments", segmentsController.postSegments);
app.put("/segments/:id", segmentsController.putSegment);
app.get("/segments/comparisons", segmentsController.getAllSegmentComparisons);
app.post("/segments/comparisons", segmentsController.postSegmentComparisons);
app.get("/segments/comparison/:id", segmentsController.getSegmentComparison);
app.put("/segments/comparison/:id", segmentsController.putSegmentComparison);
app.get(
  "/segments/comparison/:id/status",
  segmentsController.getSegmentComparisonStatus
);
app.post(
  "/segments/comparison/:id/cancel",
  segmentsController.cancelSegmentComparison
);

// Dimensions
app.get("/dimensions", dimensionsController.getAllDimensions);
app.post("/dimensions", dimensionsController.postDimensions);
app.put("/dimensions/:id", dimensionsController.putDimension);

// Reports
/*
app.get("/reports", reportsController.getReports);
app.post("/reports", reportsController.postReports);
app.get("/report/:id", reportsController.getReport);
app.put("/report/:id", reportsController.putReport);
*/

// Data Sources
app.get("/datasources", organizationsController.getDataSources);
app.get("/datasource/:id", organizationsController.getDataSource);
app.post("/datasources", organizationsController.postDataSources);
app.put("/datasource/:id", organizationsController.putDataSource);
app.delete("/datasource/:id", organizationsController.deleteDataSource);

// API keys
app.get("/keys", organizationsController.getApiKeys);
app.post("/keys", organizationsController.postApiKey);
app.delete("/key/:key", organizationsController.deleteApiKey);

// Presentations
app.get("/presentations", presentationController.getPresentations);
app.post("/presentation", presentationController.postPresentation);
app.get("/presentation/:id", presentationController.getPresentation);
app.post("/presentation/:id", presentationController.updatePresentation);
app.delete("/presentation/:id", presentationController.deletePresentation);

// Discussions
app.get(
  "/discussion/:parentType/:parentId",
  discussionsController.getDiscussion
);
app.post(
  "/discussion/:parentType/:parentId",
  discussionsController.postDiscussions
);
app.put(
  "/discussion/:parentType/:parentId/:index",
  discussionsController.putComment
);
app.delete(
  "/discussion/:parentType/:parentId/:index",
  discussionsController.deleteComment
);
app.get("/discussions/recent/:num", discussionsController.getRecentDiscussions);
app.post("/upload/:filetype", discussionsController.postImageUploadUrl);

// Admin
app.get("/admin/organizations", adminController.getOrganizations);
app.post("/admin/organization/:id/populate", adminController.addSampleData);

// Fallback 404 route if nothing else matches
app.use(function (req, res) {
  res.status(404).json({
    status: 404,
    message: "Route not found",
  });
});

// eslint-disable-next-line
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const status = err.status || 400;

  if (process.env.NODE_ENV === "production" && req.log) {
    req.log.error(err);
  } else {
    console.error(err);
  }

  res.status(status).json({
    status: status,
    message: err.message || "An error occurred",
  });
};
app.use(errorHandler);

export default app;