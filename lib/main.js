"use strict"

var fs = require("fs");
var path = require("path");

var aws = require("aws-sdk");
var glob = require("glob");
var jsonFile = require("jsonfile");
var console = require("better-console");

function event(message, data, errorOrCallback, callbackOrCallbackData, callbackData) {
	var error;
	var callback;
	var callbackData;
	if (typeof(errorOrCallback === "function")) {
		error = null;
		callback = errorOrCallback;
		callbackData = callbackOrCallbackData;
	}
	else {
		error = errorOrCallback;
		callback = callbackOrCallbackData;
	}
	if (error) {
		if (!data) data = {};
		data.error = error;
	}
	if (data) {
		var dataString = "";
		Object.keys(data).forEach(function(key) {
			dataString += "\n\t" + key + "=" + JSON.stringify(data[key]);
		})
		message = (message || "") + dataString;
	}
	if (message) console[error ? "error" : "log"](message);
	if (callback) callback(error, callbackData);
}

function getEC2Client(region) {
	return new aws.EC2( { region: region } );
}

function preProcess(regionName, templatePathPatterns, callback) {
	getEC2Client(regionName).describeRegions(function(error, regionsDescription) {
		if (error) event("Unable to get regions", { region: regionName }, error, callback);
		else {
			var regionNames = regionsDescription.Regions.map(function(o) { return o.RegionName; });
			if (!Array.isArray(templatePathPatterns) || templatePathPatterns.length === 0) templatePathPatterns = [ "./*.cloudformation" ];
			templatePathPatterns.forEach(function(templatePathPattern) {
				glob(templatePathPattern, function (error, templatePaths) {
					if (error) event("Unable to find templates", templatePathPatterns, error, callback);
					else {
						var templatesToDo = templatePaths.length;
						var templateCallback = function(message, data, error) {
							event(message, data, error, callback);
							if (--templatesToDo === 0) event("Templates processed", { paths: templatePaths }, callback, templatePaths);
						};
						templatePaths.forEach(function(templatePath) {
							var templateName = path.basename(templatePath);
							var templateDirectory = path.dirname(templatePath);
							var templateInfo = { template : templateName };
							jsonFile.readFile(templatePath, function (error, template) {
								if (error) templateCallback("Unable to read template", templateInfo, error);
								else {
									var tasksToDo = 2; // includes + ami mappings
									var taskCallback = function(message, data, error) {
										event(message, data, error, templateCallback);
										if (error) templateCallback("Template not saved", templateInfo);
										else if (--tasksToDo === 0 ) {
											jsonFile.writeFile(templatePath, template, function(error) {
												templateCallback(error ? "Unable to save template" : "Template pre-processed", templateInfo, error);
											});
										}
									}
									event("Pre-processing template", { name : templateName, tasks: tasksToDo });
									var includesPath = templatePath + ".includes";
									var includePathsPattern = includesPath + "/*/*/**";
									glob(includePathsPattern, function(error, includePaths) {
										if (error) taskCallback("Unable to get include paths", { pattern : includePathsPattern }, error);
										else {
											var includesToProcess = includePaths.length;
											var includeCallback = function(message, data, error) {
												event(message, data, error, taskCallback);
												if (--includesToProcess === 0) taskCallback("Includes completed", templateInfo);
											};
											includePaths.forEach(function(includePath) {
												var includeInfo = { template: templateName, path: includePath };
												var pathParts = path.relative(includesPath, includePath).split(path.sep);
												if (pathParts.length <= 1) includeCallback();
												else if (pathParts.some(function(pathPart) { return pathPart === "."; })) includeCallback("Ignoring include as it is a hidden file", includeInfo);
												else {
													var resourceKey = pathParts[0];
													includeInfo.resource = resourceKey;
													var resource = template.Resources[resourceKey];
													var match = pathParts[1].match(/^configs|userdata(.ps1|.cmd|)$/);
													if (!match) includeCallback("Include must be config or userdata", includeInfo);
													else {
														var includeType; // config or userdata
														var configKey; 
														var configType; // file or command
														var userdataWrapper; // powershell, cmd or empty
														var ignore;
														switch (match[0]) {
															case "configs":
																includeType = "config";
																if (pathParts.length <=3) {
																	includeCallback();
																	ignore = true;
																}
																else {
																	includeInfo.config = configKey = pathParts[2];
																	var match = pathParts[3].match(/^files|commands$/);
																	if (!match) {
																		includeCallback("Config include must be file or command", includeInfo);
																		ignore = true;
																	}
																	else {
																		switch (match[0]) {
																			case "files":
																				configType = "file";
																				break;
																			case "commands":
																				configType = "command";
																				break;
																		}
																		includeInfo.configType = configType;
																	}
																}
																break;
															default:
																includeType = "userdata";
																switch (match[1]) {
																	case ".ps1":
																		userdataWrapper = "powershell";
																		break;
																	case ".cmd":
																		userdataWrapper = "script"
																}
																includeInfo.userdataType = userdataType = match[1];
														}
														includeInfo.type = includeType;
														if (!ignore) fs.stat(includePath, function(error, stat) {
															if (error) includeCallback("Unable to get Include file stats", includeInfo, error);
															else if (!stat.isFile()) includeCallback();
															//need to support ignoring of windows system/hidden files here
															else fs.readFile(includePath, "utf8", function (error, content) {
																if (error) includeCallback(err.errno === 34 ? "Include file not found" : "Unable to read include file", includeInfo, error);
																else {
																	var templateInclude;
																	switch (configType) {
																		case "config":
																			var keyParts = pathParts.slice(4);
																			switch (configType) {
																				case "file":
																					for (var i = 0; i < keyParts.length; i++) {
																						var original = keyParts[i];
																						var working = original;
																						//if first part is e.g. C$, change to C:
																						if (i === 0) {
																							var match = working.match(/^([A-z])\$$/);
																							if (match) working = match[1] + ":";
																						}
																						//if part starts with $$ or $., remove the first $
																						var match = working.match(/^\$(\.\$.*)$/)
																						if (match) working = match[1];
																						if (working !== original) keyParts[i] = working;
																					}
																					break;
																				case "command":
																					break;
																			}
																			var key = keyParts.join("/");
																			includeInfo.key = key;
																			includeInfo.objectPath = "Resources/" + resourceKey + "/Metadata/AWS::CloudFormation::Init/" + configKey + "/" + typeKey + "/" + key;
																			templateInclude = resource.Metadata["AWS::CloudFormation::Init"][configKey][typeKey][key];
																			break;
																		case "userdata":
																			if (userdataWrapper && content) content = "<" + userdataWrapper + ">\n" + content + "\n</" + userdataWrapper + ">";
																			includeInfo.objectPath = "Resources/" + resourceKey + "/Properties";
																			templateInclude = resource.Properties;
																			break;
																	}
																	if (!templateInclude) includeCallback("Template object not found", includeInfo);
																	else {
																		var contentArray = [];
																		for (var i = 0; ; true) {
																			var searchString = content.substring(i);
																			var match = searchString.match(/(?:\{\{(ref) ([\w.:]*)\}\})|(?:\{\{(att) (\w*) ([\w.]*)\}\})/);
																			var stringToPush = null;
																			if (!match) stringToPush = searchString;
																			else {
																				var j = match.index;
																				if (j > 0) stringToPush = searchString.substring(0, j);
																			}
																			if (stringToPush) {
																				var lastIndex = contentArray.length - 1;
																				if (lastIndex > -1) {
																					var last = contentArray[lastIndex];
																					if (typeof last === "string") {
																						contentArray[lastIndex] = last + str;
																						stringToPush = null;
																					}
																				}
																				if (stringToPush) contentArray.push(stringToPush);
																			}
																			if (!match) break;
																			var variableType = (match[1] || match[3]);
																			if (variableType) {
																				var variable = null;
																				switch (variableType) {
																					case "ref":
																						variable = { "Ref": match[2]};
																						break;
																					case "att":
																						variable = { "Fn::GetAtt": [ match[4], match[5] ] };
																						break;
																				}
																				contentArray.push(variable);
																				var variableInfo = { 
																					template: templateName,
																					type: variableType,
																					string: match[0], 
																					object: JSON.stringify(variable)
																				};
																				event("Variable found", variableInfo);
																			}
																			i += j + match[0].length;
																		}
																		includeInfo.variableCount = contentArray.filter(function(o) { return typeof o === "object" }).length;
																		var contentValue = (contentArray.length === 1) ? contentArray[0] : { "Fn::Join": [ "", contentArray ] };
																		switch (type) {
																			case "config":
																				var propertyName;
																				switch (configType) {
																					case "file":
																						propertyName = "content";
																						break;
																					case "command":
																						propertyName = "command";
																						break;
																				}
																				templateInclude[propertyName] = contentValue;
																				break;
																			case "userdata":
																				templateInclude.UserData = { "Fn::Base64": contentValue };
																				break;
																		}
																		includeCallback("Include updated", includeInfo);
																	}
																}
															});
														});
													}
												}
											});
										}
									});
									var configPath = templatePath + ".config";
									var configName = path.basename(configPath);
									var configInfo = { template: templateName, config: configName }
									jsonFile.readFile(configPath, function(error, config) {
										if (error) {
											if (error.no === 34) taskCallback("Config not found", configInfo);
											else taskCallback("Unable to read config", configInfo, error);
										}
										else {
											var mappings = config.mappings;
											var mappingsKeys = Object.keys(mappings);
											var mappingsToDo = mappingsKeys.length;
											var mappingCallback = function(message, data, error) {
												event(message, data, error, taskCallback);
												if (--mappingsToDo === 0) taskCallback("Mappings updated", templateInfo);
											};
											Object.keys(mappings).forEach(function(key) {
												var mapping = mappings[key];
												var type = mapping.type;
												var mappingInfo = { template: templateName, key: key, type: type };
												var templateMapping = template.Mappings[key];
												if (!templateMapping) mappingsTaskCallback("Mapping ignored", mappingInfo);
												else {
													switch (mapping.type) {
														case "ami":
															var owner = mapping["ami:owner"];
															var name = mapping["ami:name"];
															mappingInfo.owner = owner;
															mappingInfo.name = name;
															var amiMappingRegionsToDo = regionNames.length;
															var amiMappingRegionCallback = function(message, data, error) {
																event(message, data, error, mappingCallback);
																if (--amiMappingRegionsToDo === 0) mappingCallback("Regions' AMIs updated", mappingInfo);
															};
															regionNames.forEach(function(regionName) {
																mappingInfo.region = regionName;
																event("Searching for AMI", mappingInfo);
																getEC2Client(regionName).describeImages({ 
																	Owners: [ owner ], 
																	Filters: [ { Name: "name", Values: [ name ] } ]
																}, function(error, amisDescription) {
																	if (error) amiMappingRegionCallback("AMI not found", mappingInfo, error);
																	else {
																		var amis = amisDescription.Images.sort(function(a, b) {
																			var a = a.Name;
																			var b = b.Name;
																			return (a > b) ? 1 : ((a < b) ? -1 : 0);
																		});
																		if (amis.length === 0) amiMappingRegionCallback("AMI not found", mappingInfo);
																		else {
																			var amiId = amis[0].ImageId;
																			mappingInfo.amiId = amiId;
																			templateMapping[regionName] = { ID: amiId };
																			amiMappingRegionCallback("AMI updated", mappingInfo);
																		}
																	}
																});
															});
															break;
														default:
															mappingCallback("Currently, only AMI mappings supported", mappingInfo);
															break;
													}
												}
											});
										}
									});
								}
							});
						});
					}
				});
			});
		}
	});
}

module.exports = preProcess;
