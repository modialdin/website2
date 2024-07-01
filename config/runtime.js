import http from "node:http";
import https from "node:https";
import chalk from "chalk";
import { resolve } from "node:path";
import { appConfig } from "./config.js";
import {
  db,
  getUserPayment,
  giveTierDiscordRoles,
  stripeEnabled,
} from "./apis.js";
import serveHandler from "serve-handler";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Client, PermissionsBitField } from "discord.js";

// check runtime requirements
// in both astro dev server & runtime

const majorNodeVersion = Number(process.versions.node.split(".")[0]);

if (majorNodeVersion < 19) {
  console.error("Your NodeJS version is unsupported!");
  console.error("You need at least NodeJS v19 to run Holy Unblocker");
  console.error(
    "You can fix this by upgrading NodeJS. Try installing nvm: https://github.com/nvm-sh/nvm"
  );
  process.exit(1);
}

// start the discord bot here
if (stripeEnabled && appConfig.discord.listenForJoins) {
  const client = new Client({ intents: [] });

  client.on("ready", async () => {
    console.log(`${chalk.bold("Discord:")} Logged in as ${client.user.tag}!`);

    const rolesRes = await fetch(
      `https://discord.com/api/v10/guilds/${appConfig.discord.guildId}/roles`,
      {
        headers: {
          authorization: `Bot ${appConfig.discord.botToken}`,
        },
      }
    );

    if (rolesRes.status !== 200) {
      console.error(
        "Error fetching roles for guild:",
        appConfig.discord.guildId,
        rolesRes.status
      );
      console.error(await rolesRes.text());
      if (rolesRes.status === 404) {
        console.log(
          "Make sure you invited the bot to your server! Or that the guild ID is correct"
        );
        console.log("Use this link to invite the bot:");
        // we need MANAGE_ROLES to assign ppl their roles
        // this link should have that permission set
        console.log(
          `https://discord.com/oauth2/authorize?client_id=${appConfig.discord.clientId}&scope=bot&permissions=268435456`
        );
      }
    }

    const serverRoles = await rolesRes.json();

    const clientMember = await (
      await fetch(
        `https://discord.com/api/v10/guilds/${appConfig.discord.guildId}/members/${appConfig.discord.clientId}`,
        {
          headers: {
            authorization: `Bot ${appConfig.discord.botToken}`,
          },
        }
      )
    ).json();

    if (clientMember.roles.length === 0) {
      console.error(
        "In order to give users their subscription roles, the discord bot needs a role with Manage Roles."
      );
      console.error(
        "You need to create a role, move it above the subscriber roles, and assign it to the Discord bot."
      );
      process.exit(1);
    }

    // check if we can manage roles
    const canManageRoles = clientMember.roles.some((role) =>
      new PermissionsBitField(
        serverRoles.find((e) => e.id === role).permissions
      ).has("ManageRoles")
    );

    if (!canManageRoles) {
      console.error(
        "In order to give users their subscription roles, the Discord bot needs the Manage Roles permission."
      );
      console.error("You need to give the Discord bot a role with permission.");
      process.exit(1);
    }

    const highestRoleId = clientMember.roles[clientMember.roles.length - 1];
    const highestRole = serverRoles.find((e) => e.id === highestRoleId);

    for (const tier in appConfig.discord.roleIds) {
      const id = appConfig.discord.roleIds[tier];
      const role = serverRoles.find((r) => r.id === id);
      if (role === undefined) {
        console.error("Invalid role id", id, "for tier", tier);
        process.exit(1);
      }
      if (role.position > highestRole.position) {
        console.error("Cannot give users the role", role.name);
        console.error(
          "You need to give the Discord bot a role that's higher than",
          role.name
        );
        process.exit();
      }
    }

    console.log(chalk.bold("Discord bot permissions look good."));

    // process.exit(1);
  });

  client.on("guildMemberAdd", async (member) => {
    console.log("Member", member.id, "just joined guild", member.guild.id);
    if (member.guild.id !== appConfig.discord.guildId) {
      console.log("Guild isn't part of config, ignoring!");
      return;
    }

    const user = await db.query("SELECT * FROM users WHERE discord_id = $1;", [
      member.user.id,
    ]);
    if (user) {
      console.log("Found user:", user);
      const payment = await getUserPayment(user.id);
      await giveTierDiscordRoles(user, payment?.tier);
    }
  });

  client.login(appConfig.discord.botToken);
}

/**
 * @typedef {Object} AppMirror
 * @property {string} prefix
 * @property {string} url
 */

// simple mirror middleware that supports GET/POST

/**
 * @type {AppMirror[]}
 */
const appMirrors = [];

// setup theatre mirror
if (!("theatreFiles" in appConfig))
  appMirrors.push({ prefix: "/cdn/", url: appConfig.theatreFilesMirror });

// setup theatre api mirror
if (!("db" in appConfig))
  appMirrors.push({ prefix: "/api/theatre/", url: appConfig.theatreApiMirror });

const hasTheatreFiles = "theatreFilesPath" in appConfig;

const cdnAbs = hasTheatreFiles && resolve(appConfig.theatreFilesPath);

/**
 * normalizes a /cdn/ path for static files
 */
function normalCDN(path) {
  // this will work on windows & posix paths
  return cdnAbs + "/" + path.slice("/theatre-files/cdn/".length);
}

/**
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").OutgoingMessage} res
 * @param {() => void} middleware
 */
export function handleReq(req, res, middleware) {
  const isCDN = req.url.startsWith("/cdn/");

  // THIS SHOULD ALWAYS BE SET ON THEATRE FILES AND /compat/
  // DO NOT DO NOT SET THIS ON /sub/ OR ACCOUNT DETAILS WILL BE LEAKED
  if (isCDN || req.url.startsWith("/compat/")) {
    res.setHeader("cross-origin-resource-policy", "same-origin");
  }

  if (isCDN && hasTheatreFiles) {
    serveHandler(
      req,
      res,
      {
        cleanUrls: false, // too freaky
        public: "/theatre-files/",
        trailingSlash: true,
      },
      {
        lstat(path) {
          return lstat(normalCDN(path));
        },
        realpath(path) {
          return realpath(normalCDN(path));
        },
        createReadStream(path, config) {
          return createReadStream(normalCDN(path), config);
        },
        readdir(path) {
          return readdir(normalCDN(path));
        },
        sendError() {
          req.url = "/404";
          middleware();
        },
      }
    );
    return;
  }

  // we want the uv service page to fallback to a page that registers the service worker
  // internal redirect
  if (req.url.startsWith("/uv/service/")) {
    req.url = "/register-uv";
    // app(req, res);
    return middleware();
  }

  // HIGH PERFORMANCE http proxy
  for (const mirror of appMirrors) {
    if (!req.url.startsWith(mirror.prefix)) continue;

    const sendBody = !["HEAD", "GET"].includes(req.method);
    const mirrorURL = mirror.url + req.url.slice(mirror.prefix.length);

    // console.log("Proxy:", req.url, "->", mirrorURL);

    // make the request
    const mirrorReq = (mirrorURL.startsWith("https:") ? https : http).request(
      mirrorURL,
      {
        method: req.method,
      }
    );

    mirrorReq.on("response", (mirrorRes) => {
      if (mirrorRes.statusCode === 404) {
        // display astro 404 page
        req.url = "/404";
        return middleware();
      }

      // support redirects
      const loc = mirrorRes.headers["location"];
      if (typeof loc === "string") res.setHeader("location", loc);

      const ce = mirrorRes.headers["content-encoding"];
      if (
        typeof ce === "string" &&
        ["gzip", "compress", "deflate", "br", "zstd"].includes(ce)
      )
        res.setHeader("content-encoding", ce);
      res.writeHead(mirrorRes.statusCode);
      mirrorRes.pipe(res);
    });

    // pipe request body into mirror
    if (sendBody) req.pipe(mirrorReq);
    // or just send the request
    else mirrorReq.end();

    return;
  }

  return middleware();
}