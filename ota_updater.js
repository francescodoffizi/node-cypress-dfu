var debug = require('debug')("cypress-dfu:ota_updater")
var OTAUtil = require('./ota_util.js')
var BootLoaderCommands = require('./ota_commands.js')

//States for the flashing state machine
var ENTER_BOOTLOADER_REQ = 1
var ENTER_BOOTLOADER_RES = 2
var GET_FLASH_SIZE_REQ = 3
var GET_FLASH_SIZE_RES = 4
var PROGRAM_ROW_SEND_DATA_REQ = 5
var PROGRAM_ROW_SEND_DATA_RES = 6
var PROGRAM_ROW_REQ = 7
var PROGRAM_ROW_RES = 8
var VERIFY_ROW_REQ = 9
var VERIFY_ROW_RES = 10
var VERIFY_CHECKSUM_REQ = 11
var VERIFY_CHECKSUM_RES = 12
var EXIT_BOOTLOADER_REQ = 13
var EXIT_BOOTLOADER_RES = 14
var FINISHED = 15

//Adjust MTU 138? <- Happens in firmware?
var OTAUpdater = function(otaService){
  var OTAWriter = require('./ota_writer.js')
  var otaWriter = new OTAWriter(otaService)

  var OTAReader = require('./ota_reader.js')
  var otaReader = new OTAReader()

  var updater = this

  //Initial values
  updater.currentState = ENTER_BOOTLOADER_REQ
  updater.programRowNumber = 0
  updater.programRowStartPos = 0
  updater.arrayID = 1//????

  otaService.on('data', function(data){
    data = data.toString('hex');
    updater.doState(updater.currentState, data)
  })

  this.start = function(payload){
    updater.payload = payload
    updater.doState(updater.currentState)
  }

  this.doState = function(state, data){
    debug("Performing state: "+state)
    switch(state){
      case ENTER_BOOTLOADER_REQ:
        updater.currentState = ENTER_BOOTLOADER_RES;
        otaWriter.OTAEnterBootLoaderCmd(updater.payload.checkSumType, function(err){
          if(err){
            updater.handleError(err)
            return
          }
        })
      break;
      case ENTER_BOOTLOADER_RES:
        otaReader.parseEnterBootLoaderAcknowledgement(data, function(err, siliconID, siliconRev){
          if(err){
            updater.handleError(err)
            return
          }
          else if(siliconID != updater.payload.siliconID || siliconRev != updater.payload.siliconRev){
            var message = "Payload is for incorrect silicon. Expected siliconID: "+
              siliconID +
              " siliconRev: " +
              siliconRev +
              " got siliconID: " +
              updater.payload.siliconID +
              " siliconRev: " +
              updater.payload.siliconRev;
            updater.handleError(new Error(message))
            return
          }

          updater.currentState = GET_FLASH_SIZE_REQ;
          updater.doState(updater.currentState)
        })
      break;
      case GET_FLASH_SIZE_REQ:
        updater.currentState = GET_FLASH_SIZE_RES;
        debug("Requesting flash size for arrayID", updater.arrayID)
        otaWriter.OTAGetFlashSizeCmd([updater.arrayID], updater.payload.checkSumType, 1, function(err){
          if(err){
            updater.handleError(err)
            return
          }
        })
      break;
      case GET_FLASH_SIZE_RES:
        otaReader.parseGetFlashSizeAcknowledgement(data, function(err, startRow, endRow){
          if(err){
            updater.handleError(err)
            return
          }
          updater.startRow = startRow
          updater.endRow = endRow

          debug("Flash size received: startRow: "+startRow+" endRow: "+endRow)

          updater.currentState = PROGRAM_ROW_SEND_DATA_REQ
          updater.doState(updater.currentState)
        })
      break;
      case PROGRAM_ROW_SEND_DATA_REQ:
        updater.currentState = PROGRAM_ROW_SEND_DATA_RES;
        writeProgrammableData(updater.programRowNumber)

        //TODO data

        // otaWriter.OTAProgramRowSendDataCmd(data, updater.payload.checkSumType, function(err){
        //   if(err){
        //     updater.handleError(err)
        //     return
        //   }
        // })
      break;
      case PROGRAM_ROW_SEND_DATA_RES:
        otaReader.parseParseSendDataAcknowledgement(data, function(err, status){
          if(err){
            updater.handleError(err)
            return
          }
          updater.currentState = PROGRAM_ROW_REQ
          updater.doState(updater.currentState)
        })
      break;
      case PROGRAM_ROW_REQ:
        //TODO data

        writeProgrammableData(updater.programRowNumber)

        // updater.currentState = PROGRAM_ROW_RES;
        // otaWriter.OTAProgramRowSendDataCmd(data, updater.payload.checkSumType, function(err){
        //   if(err){
        //     updater.handleError(err)
        //     return
        //   }
        // })
      break;
      case PROGRAM_ROW_RES:
        otaReader.parseParseRowAcknowledgement(data, function(err, status){
          if(err){
            updater.handleError(err)
            return
          }

          updater.currentState = VERIFY_ROW_REQ
          updater.doState(updater.currentState)
        })
      break;
      case VERIFY_ROW_REQ:
        var modelData = updater.payload.flashDataLines[updater.programRowNumber]
        var rowString = modelData.rowNumber.toString(16)
        var rowMSB = parseInt(rowString.substring(0, 2), 16);
        var rowLSB = parseInt(rowString.substring(2, 4), 16);

        updater.currentState = VERIFY_ROW_RES;
        otaWriter.OTAVerifyRowCmd(rowMSB, rowLSB, modelData, updater.payload.checkSumType, function(err){
          if(err){
            updater.handleError(err)
            return
          }
        })
      break;
      case VERIFY_ROW_RES:
        otaReader.parseVerifyRowAcknowledgement(data, function(err, status, checksum){
          if(err){
            updater.handleError(err)
            return
          }

          //Compare checksum received to calculated CheckSum
          var modelData = updater.payload.flashDataLines[updater.programRowNumber]
          var rowMSB = parseInt(modelData.rowNumber.substring(0, 2), 16);
          var rowLSB = parseInt(modelData.rowNumber.substring(2, 4), 16);

          var checkSumVerify = [];
          checkSumVerify[0] = modelData.checksum;
          checkSumVerify[1] = modelData.arrayID;
          checkSumVerify[2] = rowMSB;
          checkSumVerify[3] = rowLSB;
          checkSumVerify[4] = (modelData.dataLength & 0xFF);
          checkSumVerify[5] = ((modelData.dataLength) >> 8);
          var fileCheckSumCalculated = OTAUtil.calculateCheckSumVerifyRow(checkSumVerify).toString(16)
          var fileCheckSumCalculatedLength = fileCheckSumCalculated.length;
          var fileCheckSumByte = null;
          if (fileCheckSumCalculatedLength >= 2) {
            fileCheckSumByte = fileCheckSumCalculated.substring((fileCheckSumCalculatedLength - 2), fileCheckSumCalculatedLength);
          }
          else {
            fileCheckSumByte = "0" + fileCheckSumCalculated;
          }

          if (fileCheckSumByte.toUpperCase() == checksum.toUpperCase()) {
            updater.programRowNumber = updater.programRowNumber + 1;
            //Shows ProgressBar status
            // showProgress(mProgressBarPosition, updater.programRowNumber, mFlashRowList.size());
            if (updater.programRowNumber < updater.payload.flashDataLines.length) {
              updater.programRowStartPos = 0
              writeProgrammableData(updater.programRowNumber);
            }
            else if (updater.programRowNumber == updater.payload.flashDataLines.length) {
              updater.programRowNumber = 0
              updater.programRowStartPos = 0
                /**
                 * Writing the next command
                 * Changing the shared preference value
                 */
              updater.currentState = VERIFY_CHECKSUM_REQ
              updater.doState(updater.currentState)
              // mProgressText.setText(getActivity().getResources().
              //         getText(R.string.ota_verify_checksum));
            }
          }
          else {
            // showErrorDialogMessage(getActivity().getResources().getString(
            //         R.string.alert_message_checksum_error), false);
            updater.handleError(new Error(["Verify row checksum failed. Expected: ", fileCheckSumByte, " Got: ", checksum].join(' ')))
          }
        })
      break;
      case VERIFY_CHECKSUM_REQ:
        updater.currentState = VERIFY_CHECKSUM_RES;
        otaWriter.OTAVerifyCheckSumCmd(updater.payload.checkSumType, function(err){
          if(err){
            updater.handleError(err)
            return
          }
        })
      break;
      case VERIFY_CHECKSUM_RES:
        otaReader.parseVerifyCheckSum(data, function(err, checkSumStatus){
          if(err){
            updater.handleError(err)
            return
          }
          updater.currentState = EXIT_BOOTLOADER_REQ;
          updater.doState(updater.currentState)
        })
      break;
      case EXIT_BOOTLOADER_REQ:
        updater.currentState = EXIT_BOOTLOADER_RES;
        otaWriter.OTAExitBootloaderCmd(updater.payload.checkSumType, function(err){
          if(err){
            updater.handleError(err)
            return
          }
        })
      break;
      case EXIT_BOOTLOADER_RES:
        otaReader.parseExitBootloader(data, function(err, response){
          if(err){
            updater.handleError(err)
            return
          }
          updater.currentState = FINISHED;
          updater.doState(updater.currentState)
        })
      break;

      case FINISHED:
        //Cleanup, emit final event
        console.log("FINISHED!!!!!!!!!!!!!!")
      break;
    }
  }

  this.handleError = function(err){
    console.log("!!!!!!!!!!!!!!!!!!!!!!!ERROR: ", err)
  }

  function checkProgramRowCommandToSend(totalSize) {
    if (totalSize <= BootLoaderCommands.MAX_DATA_SIZE) {
      return true;
    }
    else {
      return false;
    }
  }

  function writeProgrammableData(rowPosition){
    debug("writeProgrammableData rowPosition: ", rowPosition)
    var startPosition = updater.programRowStartPos
    var modelData = updater.payload.flashDataLines[rowPosition]
    var mRowNo = OTAUtil.swap(parseInt(modelData.rowNumber.substring(0, 4), 16));
    if (modelData.arrayID != updater.arrayID) {
      debug("Current arrayID is incorrect. Requesting flash size again.")
      updater.currentState = GET_FLASH_SIZE_REQ;
      updater.doState(updater.currentState)
    }
    else {
      /**
       * Verify whether the program row number is within the acceptable range
       */
      if (mRowNo >= updater.startRow && mRowNo <= updater.endRow) {
          var verifyDataLength = modelData.dataLength - startPosition;
          if (checkProgramRowCommandToSend(verifyDataLength)) {
              var rowMSB = parseInt(modelData.rowNumber.substring(0, 2), 16);
              var rowLSB = parseInt(modelData.rowNumber.substring(2, 4), 16);
              var dataLength = modelData.dataLength - startPosition;
              var dataToSend = [];
              for (var pos = 0; pos < dataLength; pos++) {
                  if (startPosition < modelData.data.length) {
                      var data = modelData.data[startPosition];
                      dataToSend[pos] = data;
                      startPosition++;
                  } else {
                      break;
                  }
              }

              updater.currentState = PROGRAM_ROW_RES;
              otaWriter.OTAProgramRowCmd(rowMSB, rowLSB, modelData.arrayID,
                      dataToSend, updater.payload.checkSumType);
              // Utils.setStringSharedPreference(getActivity(),
              //         Constants.PREF_BOOTLOADER_STATE, "" +
              //                 BootLoaderCommands.PROGRAM_ROW);

              updater.programRowStartPos = 0
              // mProgressText.setText(getActivity().getResources().
              //         getText(R.string.ota_program_row));
          } else {
              var dataLength = BootLoaderCommands.MAX_DATA_SIZE;
              var dataToSend = [];
              for (var pos = 0; pos < dataLength; pos++) {
                  if (startPosition < modelData.dat.length) {
                      var data = modelData.data[startPosition];
                      dataToSend[pos] = data;
                      startPosition++;
                  } else {
                      break;
                  }
              }

              updater.currentState = PROGRAM_ROW_SEND_DATA_RES;
              otaWriter.OTAProgramRowSendDataCmd(
                      dataToSend, updater.payload.checkSumType);
              // Utils.setStringSharedPreference(getActivity(),
              //         Constants.PREF_BOOTLOADER_STATE, "" +
              //                 BootLoaderCommands.SEND_DATA);
              updater.programRowStartPos = startPosition
              // mProgressText.setText(getActivity().getResources().
              //         getText(R.string.ota_program_row));
          }
      } else {
        updater.handleError(new Error(["Program row number is not within the acceptable range.", mRowNo, updater.startRow, updater.endRow].join(" ")))
      }
    }
  }
}

module.exports = OTAUpdater
