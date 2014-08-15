"use strict"

var fs = require("fs");
var path = require("path");

var aws = require("aws-sdk");
var glob = require("glob");
var jsonFile = require("jsonfile");
var emptyObject = require("empty-object");
var console = require("better-console");
var forEach = require("foreach");

function log(message, templatePath, data) {
	var prefix = "";
	if (templatePath) {
		prefix += "Template:" + templatePath.slice(-30) + "; ";
	}
	if (data) {
		forEach(data, function(value, key) {
			prefix += key + ":" + value + "; ";
		});
	}
	console.log(prefix + message);
}

function getEC2Client(regionName) {
	return new aws.EC2( { region: regionName } );
}

function getRegionNames(regionName, callback) {
	getEC2Client(regionName).describeRegions(function(err, result) {
		if (err) callback(err);
		else {
			var names = result.Regions.map(function(o) { return o.RegionName; });
			callback(null, names);
		}
	});
}

function getConfigPaths(pathPatterns, workingDirectory, callback) {
	if (typeof workingDirectory != "string") workingDirectory = process.cwd();
	if (!Array.isArray(pathPatterns) || pathPatterns.length == 0) {
		pathPatterns = [ "*.cfnpp" ];
	}
	pathPatterns.forEach(function(pattern) {
		glob(pattern, function (err, paths) {
			if (err) callback(err);
			else {
				paths = paths.map(function(o) { return path.resolve(workingDirectory, o); } );
				callback(null, paths);
			}
		});
	});
}

function getAmiMappings(config) {
	var mappings = [];
	forEach(config.amiMappings, function(mapping, key) {
		mappings.push({
			"mappingKey": key,
			"owner": mapping.owner || "amazon",
			"name": mapping.name
		});
	});
	return mappings;
}

function pushInclude(includes, resourceKey, configKey, type, key, obj, relativeDirectory) {
	var include = { 
		"resource": resourceKey, 
		"config": configKey,
		"type": type,
		"key": key
	};
	if (obj.path) include.path = path.resolve(relativeDirectory, obj.path);
	if (obj.content) include.content = obj.content;
	includes.push(include);
}

function getIncludes(config, templatePath, relativeDirectory) {
	var includes = [];
	if (config) {
		var configIncludes = config.includes;
		if (configIncludes) {
			var directory = configIncludes.directory;
			if (!directory) directory = templatePath + ".includes";
			relativeDirectory = path.resolve(relativeDirectory, directory.toString());
			var resources = configIncludes.resources;
			if (resources) {
				forEach(resources, function(resource, resourceKey) {
					forEach(resource, function(config, configKey) {
						var files = config.files;
						if (files) {
							forEach(files, function(file, key) {
								pushInclude(includes, resourceKey, configKey, "file", key, file, relativeDirectory);
							});
						}
						var commands = config.commands;
						if (commands) {
							forEach(commands, function(command, key) {
								pushInclude(includes, resourceKey, configKey, "command", key, command, relativeDirectory);
							});
						}
					});
				});
			}
		}
	}
	return includes;
}

function getAmiId(regionName, owner, name, callback) {
	getEC2Client(regionName).describeImages({ 
		Owners: [ owner ], 
		Filters: [ { Name: "name", Values: [ name ] } ]
	}, function(err, data) {
		if (err) callback(err);
		else {
			var images = data.Images.sort(function(a,b) { f
				var a = a.Name;
				var b = b.Name;
				return (a > b) ? 1 : ((a < b) ? -1 : 0);
			});
			if (images.length == 0) callback(new Error("AMI owned by '" + owner + "' and named '" + name + "' not found"));
			else callback(null, images[0].ImageId);
		}
	});
}

function taskComplete(tasksCount, templatePath, processedTemplatePath, template, compact) {
	if (tasksCount == 0) {
		jsonFile.spaces = compact ? 0 : 2;
		jsonFile.writeFile(processedTemplatePath, template, function(err) {
			if (err) console.error("Error saving template '" + processedTemplatePath + "': " + err);
			else log("Pre-processed template", templatePath, { "Processed": processedTemplatePath });
		});
	}
}

function objectifyPush(arr, obj) {
	if (typeof obj === "string") {
		if (obj === "") return;
		var i = arr.length - 1;
		if (i > -1) {
			var last = arr[i];
			if (typeof last === "string") {
				arr[i] = last + obj;
				return;
			}
		}
	}
	arr.push(obj);
}

function objectify(templatePath, str) {
	var a = [];
	var r = /(?:\{\{(ref) ([\w.:]*)\}\})|(?:\{\{(att) (\w*) ([\w.]*)\}\})/;
	for (var i = 0;; true) {
		var s = str.substring(i);
		var m = s.match(r);
		if (m === null) {
			objectifyPush(a, s);
			break;
		}
		var j = m.index;
		if (j > 0) {
			objectifyPush(a, s.substring(0, j));
		}
		var o;
		if (m[1] == "ref") o = { "Ref": m[2] };
		else if (m[3] == "att") o = { "Fn::GetAtt": [ m[4], m[5] ] };
		objectifyPush(a, o);
		i += j + m[0].length;
	}
	var o;
	if (a === null) o = str;
	else if (a.length === 1) o = a[0];
	else o = { "Fn::Join": [ "", a ] };
	//log("Objectified", templatePath, { "string" : str, "object" : JSON.stringify(o)});
	return o;
}

function processInclude(template, templatePath, include) {
	var resourceKey = include.resource;
	var configKey = include.config;
	var config = template.Resources[resourceKey].Metadata["AWS::CloudFormation::Init"][configKey];
	if (config) {
		var type = include.type;
		var key = include.key;
		var content = include.content;
		var included = false;
		switch (type) {
			case "file":
				var file = config.files[key];
				if (file) {
					file.content = objectify(templatePath, content);
					included = true;
				}
				else console.error("There is no file named '" + key + "' in config '" + configKey + "' in resource '" + resourceKey + "'");
				break;
			case "command":
				var command = config.commands[key];
				if (command) {
					command.command = objectify(templatePath, content);
					included = true;
				}
				else console.error("There is no command named '" + key + "' in config '" + configKey + "' in resource '" + resourceKey + "'");
				break;
			default:
				console.error("Unsupported include type '" + type + "'");
				break;
		}
		if (included) {
			log("Included", templatePath, { "Resource": resourceKey, "Config": configKey, "Type": type, "Key": key });
		}
	}
	else console.error("There is no config named '" + configKey + "' in resource '" + resourceKey + "'");
}

function processTemplate(config, regionNames, templatePath, compact, processedTemplatePath) {
	log("Pre-processing template", templatePath);
	jsonFile.readFile(templatePath, function (err, template) {
		if (err) console.error("Error reading '" + templatePath + "': " + err);
		else {
			var templateDirectoryPath = path.dirname(templatePath);

			var amiMappings = getAmiMappings(config);
			var amiMappingsCount = amiMappings.length;

			var includes = getIncludes(config, templatePath, templateDirectoryPath);
			var includesCount = includes.length;

			var tasksCount = (amiMappingsCount * regionNames.length) + includesCount;

			log("Tasks acquired", templatePath, { "AMI Mappings": amiMappingsCount, "Includes": includesCount });
		
			var mappings = template.Mappings;
			amiMappings.forEach(function(amiMappingTask) {
				var mappingKey = amiMappingTask.mappingKey;
				var owner = amiMappingTask.owner;
				var name = amiMappingTask.name;
				var mapping = mappings[mappingKey];
				emptyObject(mapping);
				regionNames.forEach(function(regionName) {
				//log("AMI search...", templatePath, { "Region": regionName, "Owner" : owner, "Name": name });
					getAmiId(regionName, owner, name, function(err, amiId) {
						if (err) console.error("Error getting AMI owned by '" + owner + "' and named" + name + " in region '" + regionName + "'");
						else {
							mapping[regionName] = { ID: amiId };
							log("AMI found", templatePath, { "Region": regionName, "Owner" : owner, "Name": name, "ID": amiId });
							taskComplete(--tasksCount, templatePath, processedTemplatePath, template, compact);
						}
					});
				});
			});

			includes.forEach(function(include) {
				var content = include.content;
				if (content) {
					processInclude(template, templatePath, include);
					taskComplete(--tasksCount, templatePath, processedTemplatePath, template, compact);
				}
				else {
					var path = include.path;
					if (path) {
						fs.readFile(path, "utf8", function (err, content) {
							if (err) {
								if (err.errno == 34) console.error("File " + path + " not found");
								else console.error("Error reading file " + path + ": " + err);
							}
							else {
								include.content = content;
								delete include.path;
								processInclude(template, templatePath, include);
								taskComplete(--tasksCount, templatePath, processedTemplatePath, template, compact);
							}
						});
					}
					else console.warn("Nothing to include!");
				}
			});
		}
	});
}

function processConfigs(regionName, configPathPatterns, workingDirectory, compact, processedExtension) {
	getRegionNames(regionName, function(err, regionNames) {
		if (err) console.error("Error getting AWS regions: " + err);
		else {
			getConfigPaths(workingDirectory, configPathPatterns, function (err, configPaths) {
				if (err) console.error("Error finding configs matching '" + configPatterns + "': " + err);
				else {
					configPaths.forEach(function(configPath) {
						log("Processing config...", null, { "Path": configPath });
						jsonFile.readFile(configPath, function(err, config) {
							if (err) {
								if (err.errno == 34) console.error("Config " + configPath + " not found");
								else console.error("Error reading config " + configPath + ": " + err);
							}
							else {
								var configExtension = path.extname(configPath);
								var configDirectory = path.dirname(configPath);
								var templateName = path.basename(configPath, configExtension);
								var templatePath = path.join(configDirectory, templateName);
								var processedTemplatePath = templatePath + processedExtension;
								processTemplate(config, regionNames, templatePath, compact, processedTemplatePath);
							}
						});
					});
				}
			});
		}
	});
}

module.exports = processConfigs;
