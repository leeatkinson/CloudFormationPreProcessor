#!/usr/bin/env node

"use strict";

var path = require("path");
var fs = require("fs");

var commander = require("commander");

var libPath = path.join(path.dirname(fs.realpathSync(__filename)), "../lib/main.js");
var lib = require(libPath);

function collect(o, a) { a.push(o); return a; }

var packageJson = require("../package.json");

commander.description("CloudFormation Pre-Processor").version(packageJson.version)
.option("-r --region [region-name]", "AWS region. [eu-west-1]", "eu-west-1")
.option("-t --template [template-file-pattern]", "Template file pattern. [./*.cloudformation]", collect, [ ])
.parse(process.argv);

console.log(commander.description() + " " + commander.version());

lib(commander.region, 
	commander.templateFilePattern, 
	function(error) {
		console.log("Done!");
	});
