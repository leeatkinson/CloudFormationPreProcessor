"use strict"

var fs = require("fs");
var path = require("path");

var aws = require("aws-sdk");
var glob = require("glob");
var jsonFile = require("jsonfile");
var emptyObject = require("empty-object");
var console = require("better-console");
var forEach = require("foreach");

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

function getFileIncludes(config, relativeDirectory) {
	var fileIncludes = [];
	if (config) {
		var fileIncludes = config.fileIncludes;
		if (fileIncludes) {
			var resources = fileIncludes.resources;
			var directory = fileIncludes.directory;
			if (directory) {
				relativeDirectory = path.resolve(relativeDirectory, directory);
			}
			if (resources) {
				forEach(resources, function(fileInclude, resourceKey) {
					forEach(fileInclude, function(fileIncludeConfig, configKey) {
						forEach(fileIncludeConfig, function(fileIncludeName, fileKey){
							fileIncludes.push({ 
								"resourceKey": resourceKey, 
								"configKey": configKey, 
								"fileKey": fileKey, 
								"includePath": path.resolve(relativeDirectory, fileIncludeName)
							})
						})
					});
				});
			}
		}
	}
	return fileIncludes;
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
			else console.log("Template '" + templatePath + "' pre-processed to '" + processedTemplatePath + "'");
		});
	}
}

function processTemplate(config, regionNames, templatePath, compact, processedTemplatePath) {
	console.log("Template path is " + templatePath);
	jsonFile.readFile(templatePath, function (err, template) {
		//console.log("Template is " + JSON.stringify(template));
		if (err) console.error("Error reading '" + templatePath + "': " + err);
		else {
			var amiMappings = getAmiMappings(config);
			var amiMappingsCount = amiMappings.length;

			var fileIncludes = getFileIncludes(config, path.dirname(templatePath));
			var fileIncludesCount = fileIncludes.length;

			console.log("Template '" + templatePath + "': " + amiMappingsCount + " AMI mappings and " + fileIncludesCount + " file-includes");
			
			var tasksCount = (amiMappingsCount * regionNames.length) + fileIncludesCount;
		
			var mappings = template.Mappings;
			amiMappings.forEach(function(amiMappingTask) {
				var mappingKey = amiMappingTask.mappingKey;
				var owner = amiMappingTask.owner;
				var name = amiMappingTask.name;
				console.log("Template '" + templatePath + "', mapping '" + mappingKey + "': searching for last AMI owned by '" + owner + "' and named '" + name + "'");
				var mapping = mappings[mappingKey];
				emptyObject(mapping);
				regionNames.forEach(function(regionName) {
					getAmiId(regionName, owner, name, function(err, amiId) {
						if (err) console.error("Error getting AMI owned by '" + owner + "' and named" + name + " in region '" + regionName + "'");
						else {
							mapping[regionName] = { ID: amiId };
							console.log("Template '" + templatePath + "', mapping '" + mappingKey + "', region " + regionName + ", AMI is " + amiId);
							taskComplete(--tasksCount, templatePath, processedTemplatePath, template, compact);
						}
					});
				});
			});

			var resources = template.Resources;
			fileIncludes.forEach(function(fileInclude) {
				var resourceKey = fileInclude.resourceKey;
				var configKey = fileInclude.configKey;
				var fileKey = fileInclude.fileKey;
				var includePath = fileInclude.includePath; 
				console.log("Template '" + templatePath + "', resource '" + resourceKey + "', including '" + includePath + "' as '" + fileKey + "'");
				fs.readFile(includePath, "utf8", function (err, content) {
					if (err) {
						if (err.errno == 34) console.error("File " + includePath + " not found");
						else console.error("Error reading file " + includePath + ": " + err);
					}
					else {
						var config = resources[resourceKey].Metadata["AWS::CloudFormation::Init"][configKey];
						if (config) {
							var file = config.files[fileKey];
							if (file) {
								file.content = content;
							}
							else console.error("There is no file named '" + fileKey + "' in config '" + configKey + "'");
						}
						else console.error("There is no config named '" + configKey + "'");
						taskComplete(--tasksCount, templatePath, processedTemplatePath, template, compact);
					}
				});
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
						console.log("Config path '" + configPath + "'...");
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
