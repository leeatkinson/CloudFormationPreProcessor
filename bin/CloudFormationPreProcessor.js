#!/usr/bin/env node

"use strict";

console.log("CloudFormation Pre-Processor");

var path = require("path");
var fs = require("fs");

var commander = require("commander");

var libPath = path.join(path.dirname(fs.realpathSync(__filename)), "../lib/CloudFormationPreProcessor.js");
var lib = require(libPath);

function collect(val, m) { m.push(val); return m; }

commander
.version("0.0.2")
.option("-r --region [region-name]", "AWS region [eu-west-1]", "eu-west-1")
.option("-d --working-directory [working-directory]", "Working directory [current working directory]")
.option("-f --config-file-pattern [config-file-pattern]", "Config file pattern [*.cfnpp]", collect, [ ])
.option("-c --compact", "Compact template")
.option("-e --processed-template-extension [extension]", "Processed template extension - if blank, overwrites template []", "")
.parse(process.argv);

lib(commander.region, commander.configFilePattern, commander.workingDirectory, commander.compact, commander.processedTemplateExtension);
