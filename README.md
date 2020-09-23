AWS CloudFormation PreProcessor
===============================

An AWS CloudFormation template pre-processor

Features
--------
* Update to the current AMIs - for example, the 'latest' Windows 2012 AMI from Amazon. 'Latest' is determined by sorting their names alphabetically and selecting the last.
* Include external files into UserData and CloudFormation-Init files and commands, parsing content for { "Ref", ...} and { "Fn::GetAttr" }.

Clone
-----
```bash
git clone https://github.com/leeatkinson/aws-cloudformation-preprocess.git
```

Install
-------
```bash
npm install --global cloudformation-preprocessor
```

Preparation
-----------

1) Create your CloudFormation template as normal, with any AMI mappings you want updating in the following format:

```json
{
    ...
    "Mappings": {
        ...
        "<mapping-name>": {
            "us-west-1": { "id": "<ami-id>" },
            "ap-southeast-1": { "id": "<ami-id>" },
            ...
        },
    ...
}
```

2) Create a folder whose path is the same as the template but has an extra '.d' extension, and create two subfolders - 'mappings' and 'resources'. 

```
MyTemplate.cloudformation
MyTemplate.cloudformation.d/
    mappings/
    resources/
```
3) (Currently, the pre-processor only supports AMI mappings.) Inside the mappings folder, create a JSON file with the same name as the mapping in the template and a '.json' extension. The JSON for an AMI mapping is:

```json
{
    "type": "ami",
    "ami": {
        "owner": "<owner>",
        "name": "Windows_Server-2012-RTM-English-64Bit-Base*"
    }
}
```

If `ami.owner` is unspecified, 'amazon' is used.

4) Create a folder under the 'resources' folder with the same name as the resource itself.

`MyTemplate.cloudformation.d/resources/`

5) Create a UserData file in the above resource's directory and name it 'userdata'. If this file has a .ps1 or .cmd file extension, the content is wrapped with &lt;powershell&gt;&lt;/powershell&gt; or &lt;script&gt;&lt;/script&gt; tags as appropriate before including in the template.

`MyTemplate.cloudformation.d/resources/MyInstance/userdata.ps1`

6) For CloudFormation-Init files and commands, these are placed heirachically within the resource's directory, such as:

`MyTemplate.cloudformation.d/resources/MyResource/configs/MyConfig/files/key`
`MyTemplate.cloudformation.d/resources/MyResource/configs/MyConfig/commands/key`

where `key` is the file key in the CloudFormation template.

For specifying a drive letter for Windows instances use the $ character instead of the : character (e.g. C$ instead of C:).

`MyTemplate.cloudformation.d/resources/MyResource/configs/MyConfig/files/C$/folder/file`

For specifying hidden files (without hiding them on you development machine) prefix the name with '$.'.

`MyTemplate.cloudformation.d/resources/MyResource/configs/MyConfig/files/folder/$.file`

Within files and commands, you can use {{ref foo}} and {{att foo bar}} and these will be converted to the appropriate cloudformation template objects { "Ref": "foo" } and { "Fn:GetAtt": [ "foo", "bar" ] }.

Execution
---------

You can execute the CloudFormation PreProcessor without any arguments, and it will pre-process all templates with .cloudformation file extension in the current working directory.

```bash
cfnpp
```

To specify a different file pattern specify them as a argument.

```bash
aws-cloudformation-preprocess *.json
```

By default, the region used to find all other regions is EU-WEST-1. If you want to change this, use the -r or --region argument

```bash
aws-cloudformation-preprocess -r us-east-1
```
