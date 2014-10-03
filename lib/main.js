"use strict"

var fs = require("fs");
var path = require("path");

var aws = require("aws-sdk");
var glob = require("glob");
var jsonFile = require("jsonfile");
var console = require("better-console");
var prettyjson = require('prettyjson');

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
	if (message || data) message = prettyjson.render({ message: message, data: data });
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
							if (--templatesToDo === 0) event("Templates completed", { paths: templatePaths }, callback, templatePaths);
						};
						templatePaths.forEach(function(templatePath) {
							var templateName = path.basename(templatePath);
							var templateDirectory = path.dirname(templatePath);
							var templateInfo = { template : templateName };
							jsonFile.readFile(templatePath, function (error, template) {
								if (error) templateCallback("Unable to read template", templateInfo, error);
								else {
									var originalTemplateString = JSON.stringify(template);
									var tasksToDo = 2; // resources + mappings
									var taskCallback = function(message, data, error) {
										event(message, data, error, templateCallback);
										if (error) templateCallback("Template not saved", templateInfo);
										else if (--tasksToDo === 0 ) {
											var templateString = JSON.stringify(template);
											var templateChanged = (templateString !== originalTemplateString);
											if (templateChanged) jsonFile.writeFile(templatePath, template, function(error) {
												templateCallback(error ? "Unable to save template" : "Template completed", templateInfo, error);
											});
											else templateCallback("Template unchanged", templateInfo);
										}
									}
									event("Pre-processing template", { name : templateName, tasks: tasksToDo });
									var directoryPath = templatePath + ".d";
									var resourcesPath = path.join(directoryPath, "resources");
									var includePathsPattern = resourcesPath + "/*/*/**";
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
												var pathParts = path.relative(resourcesPath, includePath).split(path.sep);
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
																		break;
																}
																includeInfo.userdataType = userdataType = match[1];
														}
														includeInfo.type = includeType;
														if (!ignore) fs.stat(includePath, function(error, stat) {
															if (error) includeCallback("Unable to get Include file stats", includeInfo, error);
															else if (!stat.isFile()) includeCallback();
															//need to support ignoring of windows system/hidden files here
															else fs.readFile(includePath, "utf8", function (error, contentString) {
																if (error) includeCallback(err.errno === 34 ? "Include file not found" : "Unable to read include file", includeInfo, error);
																else {
																	var includeObject;
																	var includeProperty;
																	var objectPath = "Resources/" + resourceKey;
																	switch (includeType) {
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
																					includeProperty = "content";
																					break;
																				case "command":
																					includeProperty = "command";
																					break;
																			}
																			var key = keyParts.join("/");
																			includeInfo.key = key;
																			var typeKey = configType + "s";
																			objectPath += "/Metadata/AWS::CloudFormation::Init/" + configKey + "/" + typeKey + "/\"" + key + "\"";
																			includeObject = resource.Metadata["AWS::CloudFormation::Init"][configKey][typeKey][key];
																			break;
																		case "userdata":
																			if (userdataWrapper && contentString) contentString = "<" + userdataWrapper + ">\n" + contentString + "\n</" + userdataWrapper + ">";
																			objectPath += "/Properties";
																			includeObject = resource.Properties;
																			includeProperty = "UserData";
																			break;
																	}
																	includeInfo.objectPath = (objectPath += "/" + includeProperty);
																	if (!includeObject) includeCallback("Template object not found", includeInfo);
																	else {
																		var originalContentString = JSON.stringify(includeObject[includeProperty]);
																		var contentArray = [];
																		for (var i = 0; ; true) {
																			var searchString = contentString.substring(i);
																			var match = searchString.match(/(?:\{\{((?:b64)?ref) ([\w.:]*)\}\})|(?:\{\{(att) (\w*) ([\w.]*)\}\})/);
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
																					case "b64ref":
																						variable = { "Ref": match[2] };
																						if (variableType === "b64ref") variable = { "Fn::Base64" : variable };
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
																		var contentObject = (contentArray.length === 1) ? contentArray[0] : { "Fn::Join": [ "", contentArray ] };
																		if (contentObject && (includeType === "userdata")) contentObject = { "Fn::Base64": contentObject }
																		contentString = JSON.stringify(contentObject);
																		var contentChanged = (contentString !== originalContentString);
																		if (contentChanged) includeObject[includeProperty] = contentObject;
																		includeCallback(contentChanged ? "Include changed" : "Include unchanged", includeInfo);
																	}
																}
															});
														});
													}
												}
											});
										}
									});
									var mappingsPath = path.join(directoryPath, "mappings");
									var mappingPathsPattern = mappingsPath + "/*";
									glob(mappingPathsPattern, function(error, mappingPaths) {
										if (error) taskCallback("Unable to get mappings paths", { pattern : mappingPathsPattern }, error);
										else {
											var mappingsToProcess = mappingPaths.length;
											var mappingCallback = function(message, data, error) {
												event(message, data, error, taskCallback);
												if (--mappingsToProcess === 0) taskCallback("Mappings completed", templateInfo);
											};
											mappingPaths.forEach(function(mappingPath) {
												var mappingExtension = path.extname(mappingPath)
												var mappingName = path.basename(mappingPath, mappingExtension);
												var mappingInfo = {
													template: templateName,
													path: mappingPath,
													name: mappingName
												};
												jsonFile.readFile(mappingPath, function(error, mapping) {
													if (error) {
														if (error.no === 34) taskCallback("Config not found", mappingInfo);
														else taskCallback("Unable to read mapping", mappingInfo, error);
													}
													else {
														var type = mapping.type;
														mappingInfo.type = type;
														var templateMapping = template.Mappings[mappingName];
														if (!templateMapping) mappingCallback("Mapping ignored", mappingInfo);
														else {
															switch (mapping.type) {
																case "ami":
																	var ami = mapping.ami;
																	var owner = ami.owner;
																	var name = ami.name;
																	mappingInfo.ami = { owner: owner, name: name };
																	var amiMappingRegionsToDo = regionNames.length;
																	var amiMappingRegionCallback = function(message, data, error) {
																		event(message, data, error, mappingCallback);
																		if (--amiMappingRegionsToDo === 0) mappingCallback("Regions' AMIs completed", mappingInfo);
																	};
																	regionNames.forEach(function(regionName) {
																		mappingInfo.region = regionName;
																		var amiMappingRegion = templateMapping[regionName];
																		var originalAmiId = amiMappingRegion ? amiMappingRegion.ID : null;
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
																					var ami = amis[0];
																					var amiId = ami.ImageId;
																					mappingInfo.ami = { 
																						name: ami.Name, 
																						id: amiId, 
																						owner: ami.ImageOwnerAlias, 
																						platform: ami.Platform, 
																						architecture: ami.Architecture 
																					};
																					var amiChanged = (amiId !== originalAmiId);
																					if (amiChanged) {
																						if (originalAmiId) mappingInfo.originalAmiId = originalAmiId;
																						templateMapping[regionName] = { ID: amiId };
																					}
																					amiMappingRegionCallback(amiChanged ? "AMI changed" : "AMI unchanged", mappingInfo);
																					delete mappingInfo.amiId;
																					delete mappingInfo.previousAmiId;
																				}
																			}
																		});
																		delete mappingInfo.region;
																	});
																	break;
																default:
																	mappingCallback("Currently, only AMI mappings supported", mappingInfo);
																	break;
															}
														}
													}
												});
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
