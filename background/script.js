// Global variables
var FileName = 'credentials';
var RoleArns = {};
const AlarmName = "samlAssumeRoleAlarm";
const refreshCreds = 55 //  How often the additional roles need to be refreshed in minutes
var SamlCreds;

// When this background process starts, load variables from chrome storage 
// from saved Extension Options
loadItemsFromStorage();
// Additionaly on start of the background process it is checked if this extension can be activated
chrome.storage.sync.get({
  // The default is activated
  Activated: true
}, function (item) {
  if (item.Activated) addOnBeforeRequestEventListener();
});
// Additionaly on start of the background process it is checked if a new version of the plugin is installed.
// If so, show the user the changelog
// var thisVersion = chrome.runtime.getManifest().version;
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason == "install" || details.reason == "update") {
    // Open a new tab to show options html page
    chrome.tabs.create({
      url: "../options/options.html"
    });
  }
});



// Function to be called when this extension is activated.
// This adds an EventListener for each request to signin.aws.amazon.com
function addOnBeforeRequestEventListener() {
  if (chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequestEvent)) {
    console.log("ERROR: onBeforeRequest EventListener could not be added, because onBeforeRequest already has an EventListener.");
  } else {
    chrome.webRequest.onBeforeRequest.addListener(
      onBeforeRequestEvent, {
        urls: ["https://signin.aws.amazon.com/saml"]
      }, ["requestBody"]
    );
  }
}



// Function to be called when this extension is de-actived
// by unchecking the activation checkbox on the popup page
function removeOnBeforeRequestEventListener() {
  chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequestEvent);
}



// Callback function for the webRequest OnBeforeRequest EventListener
// This function runs on each request to https://signin.aws.amazon.com/saml
function onBeforeRequestEvent(details) {
  // Decode base64 SAML assertion in the request
  var samlXmlDoc = "";
  var formDataPayload = undefined;
  if (details.requestBody.formData) {
    samlXmlDoc = decodeURIComponent(unescape(window.atob(details.requestBody.formData.SAMLResponse[0])));
  } else if (details.requestBody.raw) {
    var combined = new ArrayBuffer(0);
    details.requestBody.raw.forEach(function (element) {
      var tmp = new Uint8Array(combined.byteLength + element.bytes.byteLength);
      tmp.set(new Uint8Array(combined), 0);
      tmp.set(new Uint8Array(element.bytes), combined.byteLength);
      combined = tmp.buffer;
    });
    var combinedView = new DataView(combined);
    var decoder = new TextDecoder('utf-8');
    formDataPayload = new URLSearchParams(decoder.decode(combinedView));
    samlXmlDoc = decodeURIComponent(unescape(window.atob(formDataPayload.get('SAMLResponse'))))
  }
  // Convert XML String to DOM
  parser = new DOMParser()
  domDoc = parser.parseFromString(samlXmlDoc, "text/xml");
  // Get a list of claims (= AWS roles) from the SAML assertion
  var roleDomNodes = domDoc.querySelectorAll('[Name="https://aws.amazon.com/SAML/Attributes/Role"]')[0].childNodes
  // Parse the PrincipalArn and the RoleArn from the SAML Assertion.
  var PrincipalArn = '';
  var RoleArn = '';
  var SAMLAssertion = undefined;
  var hasRoleIndex = false;
  var roleIndex = "";
  if (details.requestBody.formData) {
    SAMLAssertion = details.requestBody.formData.SAMLResponse[0];
    hasRoleIndex = "roleIndex" in details.requestBody.formData;
    roleIndex = details.requestBody.formData.roleIndex[0];
  } else if (formDataPayload) {
    SAMLAssertion = formDataPayload.get('SAMLResponse');
    roleIndex = formDataPayload.get('roleIndex');
    hasRoleIndex = roleIndex != undefined;
  }
  // If there is more than 1 role in the claim, look at the 'roleIndex' HTTP Form data parameter to determine the role to assume
  if (roleDomNodes.length > 1 && hasRoleIndex) {
    for (i = 0; i < roleDomNodes.length; i++) {
      var nodeValue = roleDomNodes[i].innerHTML;
      if (nodeValue.indexOf(roleIndex) > -1) {
        // This DomNode holdes the data for the role to assume. Use these details for the assumeRoleWithSAML API call
        // The Role Attribute from the SAMLAssertion (DomNode) plus the SAMLAssertion itself is given as function arguments.
        extractPrincipalPlusRoleAndAssumeRole(nodeValue, SAMLAssertion)
      }
    }
  }
  // If there is just 1 role in the claim there will be no 'roleIndex' in the form data.
  else if (roleDomNodes.length == 1) {
    // When there is just 1 role in the claim, use these details for the assumeRoleWithSAML API call
    // The Role Attribute from the SAMLAssertion (DomNode) plus the SAMLAssertion itself is given as function arguments.
    extractPrincipalPlusRoleAndAssumeRole(roleDomNodes[0].innerHTML, SAMLAssertion)
  }
}



// Called from 'onBeforeRequestEvent' function.
// Gets a Role Attribute from a SAMLAssertion as function argument. Gets the SAMLAssertion as a second argument.
// This function extracts the RoleArn and PrincipalArn (SAML-provider)
// from this argument and uses it to call the AWS STS assumeRoleWithSAML API.
function extractPrincipalPlusRoleAndAssumeRole(samlattribute, SAMLAssertion) {
  // Pattern for Role
  var reRole = /arn:aws:iam:[^:]*:[0-9]+:role\/[^,]+/i;
  // Patern for Principal (SAML Provider)
  var rePrincipal = /arn:aws:iam:[^:]*:[0-9]+:saml-provider\/[^,]+/i;
  // Extraxt both regex patterns from SAMLAssertion attribute
  RoleArn = samlattribute.match(reRole)[0];
  PrincipalArn = samlattribute.match(rePrincipal)[0];
  var params = {
    PrincipalArn: PrincipalArn,
    RoleArn: RoleArn,
    SAMLAssertion: SAMLAssertion,
    DurationSeconds: (Duration * 60)
  };
  // Call STS API from AWS
  var sts = new AWS.STS();
  sts.assumeRoleWithSAML(params, function (err, data) {
    if (err) console.log(err.message); // an error occurred
    else {
      // On succesful API response create file with the STS keys
      var docContent = "[default] \n" +
        "aws_access_key_id = " + data.Credentials.AccessKeyId + " \n" +
        "aws_secret_access_key = " + data.Credentials.SecretAccessKey + " \n" +
        "aws_session_token = " + data.Credentials.SessionToken;

      // Saving Creds for use when triggered.
      SamlCreds = data.Credentials;
      console.log("Creds expiring in ", data.Credentials.Expiration);
      // If there are no Role ARNs configured in the options panel, continue to create credentials file
      // Otherwise, extend docContent with a profile for each specified ARN in the options panel
      if (Object.keys(RoleArns).length == 0) {
        console.log('Output maken');
        outputDocAsDownload(docContent);
      } else {
        var profileList = Object.keys(RoleArns);
        console.log('INFO: Do additional assume-role for role -> ' + RoleArns[profileList[0]]);

        assumeAdditionalRole(profileList, 0, data.Credentials.AccessKeyId, data.Credentials.SecretAccessKey, data.Credentials.SessionToken, docContent);
      }
    }
  });

}


// Will fetch additional STS keys for 1 role from the RoleArns dict
// The assume-role API is called using the credentials (STS keys) fetched using the SAML claim. Basically the default profile.
function assumeAdditionalRole(profileList, index, AccessKeyId, SecretAccessKey, SessionToken, docContent) {
  // Set the fetched STS keys from the SAML reponse as credentials for doing the API call
  var options = {
    'accessKeyId': AccessKeyId,
    'secretAccessKey': SecretAccessKey,
    'sessionToken': SessionToken
  };
  var sts = new AWS.STS(options);
  // Set the parameters for the AssumeRole API call. Meaning: What role to assume
  var params = {
    RoleArn: RoleArns[profileList[index]],
    RoleSessionName: profileList[index]
  };
  // Call the API
  sts.assumeRole(params, function (err, data) {
    if (err) console.log(err.message); // an error occurred
    else {
      docContent += " \n\n" +
        "[" + profileList[index] + "] \n" +
        "aws_access_key_id = " + data.Credentials.AccessKeyId + " \n" +
        "aws_secret_access_key = " + data.Credentials.SecretAccessKey + " \n" +
        "aws_session_token = " + data.Credentials.SessionToken;
    }
    // If there are more profiles/roles in the RoleArns dict, do another call of assumeAdditionalRole to extend the docContent with another profile
    // Otherwise, this is the last profile/role in the RoleArns dict. Proceed to creating the credentials file
    if (index < profileList.length - 1) {
      console.log('INFO: Do additional assume-role for role -> ' + RoleArns[profileList[index + 1]]);
      assumeAdditionalRole(profileList, index + 1, AccessKeyId, SecretAccessKey, SessionToken, docContent);
    } else {
      outputDocAsDownload(docContent);
    }
  });
}



// Called from either extractPrincipalPlusRoleAndAssumeRole (if RoleArns dict is empty)
// Otherwise called from assumeAdditionalRole as soon as all roles from RoleArns have been assumed 
function outputDocAsDownload(docContent) {
  var doc = URL.createObjectURL(new Blob([docContent], {
    type: 'application/octet-binary'
  }));
  // Triggers download of the generated file
  chrome.downloads.download({
    url: doc,
    filename: FileName,
    conflictAction: 'overwrite',
    saveAs: false
  });
}



// This Listener receives messages from options.js and popup.js
// Received messages are meant to affect the background process.
chrome.runtime.onMessage.addListener(
  function (request, sender, sendResponse) {
    // When the options are changed in the Options panel
    // these items need to be reloaded in this background process.
    if (request.action == "reloadStorageItems") {
      loadItemsFromStorage();
      sendResponse({
        message: "Storage items reloaded in background process."
      });
    }
    // When the activation checkbox on the popup screen is checked/unchecked
    // the webRequest event listener needs to be added or removed.
    if (request.action == "addWebRequestEventListener") {
      addOnBeforeRequestEventListener();
      sendResponse({
        message: "webRequest EventListener added in background process."
      });
    }
    if (request.action == "removeWebRequestEventListener") {
      removeOnBeforeRequestEventListener();
      sendResponse({
        message: "webRequest EventListener removed in background process."
      });
    }
  });


function alarmListener(alarm) {
  if (alarm.name === AlarmName) {
    console.log('alarm trigger, refreshing additional roles.', Date.now());

    //https://developer.chrome.com/extensions/alarms#type-Alarm
    chrome.alarms.create(AlarmName, {
      //  delayInMinutes: 0.1,
      periodInMinutes: refreshCreds
    });

    // Refreshing the creds
    var docContent = "[default] \n" +
      "aws_access_key_id = " + SamlCreds.AccessKeyId + " \n" +
      "aws_secret_access_key = " + SamlCreds.SecretAccessKey + " \n" +
      "aws_session_token = " + SamlCreds.SessionToken;


    var profileList = Object.keys(RoleArns);
    console.log('INFO: Do additional assume-role for role -> ' + RoleArns[profileList[0]]);
    assumeAdditionalRole(profileList, 0, SamlCreds.AccessKeyId, SamlCreds.SecretAccessKey, SamlCreds.SessionToken, docContent);
  }
}
chrome.alarms.onAlarm.addListener(alarmListener);

function loadItemsFromStorage() {
  chrome.storage.sync.get({
    FileName: 'credentials',
    RoleArns: {},
    Duration: 60
  }, function (items) {
    FileName = items.FileName;
    RoleArns = items.RoleArns;
    Duration = items.Duration;
  });
}