#!/usr/bin/env node

"use strict";

var path = require("path");
var fs = require("fs");

var commander = require("commander");

var libPath = path.join(path.dirname(fs.realpathSync(__filename)), "../lib/CloudFormationPreProcessor.js");
var lib = require(libPath);

function collect(o, a) { a.push(o); return a; }

commander.description("CloudFormation Pre-Processor").version("1.1.0")
.option("-r --region [region-name]", "AWS region. [eu-west-1]", "eu-west-1")
.option("-d --working-directory [working-directory]", "Working directory. [current working directory]")
.option("-f --config-file-pattern [config-file-pattern]", "Config file pattern. [*.cfnpp]", collect, [ ])
.option("-c --compact", "Compact template. [true]")
.option("-e --processed-template-extension [extension]", "Processed template extension. If blank, overwrites template. []", "")
.parse(process.argv);

console.log(commander.description() + " " + commander.version());

lib(commander.region, commander.configFilePattern, commander.workingDirectory, commander.compact, commander.processedTemplateExtension);
