sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment"
], function (Controller, JSONModel, MessageToast, MessageBox, Fragment) {
    "use strict";

    return Controller.extend("timetracker.controller.View1", {
        _timerInterval: null,
        _oSubmitDialog: null,
        _sCsrfToken: null,
        _filterDebounceTimer: null,
        sHanaServiceUrl: "/sap/opu/odata4/sap/zapi_cs_cio_tt_o4/srvd_a2x/sap/zapi_cs_cio_tt_o4/0001/ZC_CS_CIO_TT",

        onInit: function () {
            this._initializeUserId().then(() => {
                this._initModels();
                this.loadOrdersAndTimeEntries();
            });
        },

        _initModels: function () {
            this.getView().setModel(new JSONModel({ busy: false }), "busy");

            this.getView().setModel(new JSONModel({
                activeOrderId: null,
                activeOperationId: null
            }), "activeTimer");

            this.getView().setModel(new JSONModel({
                orderId: null,
                operationId: null,
                workStartDate: null,
                workFinishDate: null,
                actualWork: 0.0,
                confirmationText: "",
                isFinalConfirmation: false,
                contextPath: null,
                timeEntryId: null,
                ActivityType: null
            }), "dialog");

            const oComponent = this.getOwnerComponent();
            oComponent.setModel(new JSONModel({ isProgressPanelVisible: false }), "viewState");
            oComponent.setModel(new JSONModel({ entries: [] }), "drafts");
            oComponent.setModel(new JSONModel({ entries: [] }), "overheadFailures");
            oComponent.setModel(new JSONModel({ orders: [] }), "orders");

            this.saveEntryToDrafts();
        },

        _setBusy: function (bBusy) {
            this.getView().getModel("busy").setProperty("/busy", bBusy);
        },

        getCurrentUserId: function () {
            return this.sUserIdFLP || 'Undefined';
        },

        _initializeUserId: function () {
            return new Promise(resolve => {
                if (sap.ushell && sap.ushell.Container) {
                    sap.ushell.Container.getServiceAsync("UserInfo").then((oUserInfo) => {
                        this.sUserIdFLP = oUserInfo.getId();
                        resolve();
                    }).catch(() => resolve());
                } else {
                    resolve();
                }
            });
        },

        _toCSTIsoString: function (oDate) {
            const d = oDate || new Date();
            const options = {
                timeZone: "America/Chicago",
                hour12: false,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            };

            const fmt = new Intl.DateTimeFormat('en-US', options);
            const parts = fmt.formatToParts(d);
            const getPart = (type) => parts.find(p => p.type === type).value;

            return `${getPart('year')}-${getPart('month')}-${getPart('day')}T${getPart('hour')}:${getPart('minute')}:${getPart('second')}`;
        },

        _parseServerCSTToLocalDate: function (sExecDate, sExecTime) {
            if (!sExecDate || !sExecTime) return null;

            const sCSTString = `${sExecDate}T${sExecTime}`;
            const dNowLocal = new Date();
            const sNowCSTString = this._toCSTIsoString(dNowLocal);

            const tNowLocal_asTime = dNowLocal.getTime();
            const tNowCST_asTime = new Date(sNowCSTString).getTime();

            const iOffsetMs = tNowLocal_asTime - tNowCST_asTime;

            const dServerAsLocal = new Date(sCSTString);
            const dCorrectedLocal = new Date(dServerAsLocal.getTime() + iOffsetMs);

            return dCorrectedLocal;
        },

        _verifyEntryStatus: async function(sSapUUID, sExpectedStatus) {
            if (!sSapUUID) return false;
            const sUrl = `${this.sHanaServiceUrl}(${encodeURIComponent(sSapUUID)})`;
            try {
                const response = await this._authenticatedFetch(sUrl, "GET");
                if(!response.ok) return false;
                const data = await response.json();
                const oEntry = data.d || data; 
                return oEntry.Status === sExpectedStatus;
            } catch (error) {
                return false;
            }
        },

        loadOrdersAndTimeEntries: async function () {
            this._setBusy(true);
            try {
                const sFilter = "MaintOrderCreationDateTime gt datetimeoffset'2025-06-01T00:00:00Z' and MaintenanceOrderType eq 'EREF'";
                const sUrl = `/sap/opu/odata/sap/API_MAINTENANCEORDER;v=2/MaintenanceOrder?$filter=${encodeURIComponent(sFilter)}&$expand=to_MaintenanceOrderOperation&$format=json`;

                const response = await this._authenticatedFetch(sUrl);
                const data = await response.json();
                let aOrdersRaw = data.d ? data.d.results : [];

                aOrdersRaw = aOrdersRaw.filter(oOrder => {
                    const bOrderMatches = oOrder.SystemStatusText && oOrder.SystemStatusText.startsWith("REL");
                    if (bOrderMatches) {
                        if (oOrder.to_MaintenanceOrderOperation && oOrder.to_MaintenanceOrderOperation.results) {
                            oOrder.to_MaintenanceOrderOperation.results = oOrder.to_MaintenanceOrderOperation.results.filter(oOp => {
                                return !oOp.SystemStatusText || !oOp.SystemStatusText.startsWith("CNF");
                            });
                        }
                        return true;
                    }
                    return false;
                });

                const aFlatOrders = this._processOrders(aOrdersRaw);
                this.getOwnerComponent().getModel("orders").setProperty("/orders", aFlatOrders);

                const aTimeEntries = await this.fetchActiveTimeEntries();
                this.mergeTimeEntriesWithOrders(aTimeEntries);

                this.startGlobalTimerInterval();
                this.updatePanelVisibility();
            } catch (err) {
                MessageBox.error(err.message);
            } finally {
                this._setBusy(false);
            }
        },

        _processOrders: function (aOrdersRaw) {
            const aFlatOrders = [];
            aOrdersRaw.forEach(order => {
                const aOperations = order.to_MaintenanceOrderOperation ? order.to_MaintenanceOrderOperation.results : [];
                aOperations.forEach(op => {
                    aFlatOrders.push({
                        orderId: order.MaintenanceOrder,
                        orderDesc: order.MaintenanceOrderDesc,
                        operationId: op.MaintenanceOrderOperation,
                        operationDesc: op.OperationDescription,
                        workCenter: op.WorkCenter || order.MainWorkCenter,
                        systemStatus: op.SystemStatusText || order.SystemStatusText,
                        reqStartDate: this._formatDate(op.OpErlstSchedldExecStrtDteTme),
                        reqEndDate: this._formatDate(op.OpErlstSchedldExecEndDteTme),
                        assignedTo: op.OperationPersonResponsible || order.MaintOrdPersonResponsible,
                        activityType: op.ActivityType || order.MaintenanceActivityType,
                        timerState: {
                            elapsedSeconds: 0,
                            baseElapsedSeconds: 0,
                            isRunning: false,
                            clockInTime: null,
                            timeEntryId: null
                        }
                    });
                });
            });
            return aFlatOrders;
        },

        fetchActiveTimeEntries: async function () {
            const sUserId = this.getCurrentUserId();
            const sFilter = `UserID eq '${sUserId}'`;
            const sUrl = `${this.sHanaServiceUrl}?$filter=${encodeURIComponent(sFilter)}&$format=json`;

            try {
                const response = await this._authenticatedFetch(sUrl);
                const data = await response.json();
                const aAllResults = data.value || (data.d ? data.d.results : []);
                return aAllResults.filter(item => item.Status === 'InProcess');
            } catch (e) {
                console.error("Failed to fetch active time entries:", e);
                return [];
            }
        },

        mergeTimeEntriesWithOrders: function (aTimeEntries) {
            const oOrdersModel = this.getOwnerComponent().getModel("orders");
            const aOrders = oOrdersModel.getProperty("/orders");
            let bHasChanges = false;
            const dNowLocal = new Date();

            aTimeEntries.forEach(oEntry => {
                const oOrder = aOrders.find(o =>
                    String(parseInt(o.orderId, 10)) === String(parseInt(oEntry.OrderID, 10)) &&
                    String(parseInt(o.operationId, 10)) === String(parseInt(oEntry.OperationSo, 10))
                );

                if (oOrder) {
                    const dStartLocal = this._parseServerCSTToLocalDate(oEntry.ExecStartDate, oEntry.ExecStartTime);

                    if (dStartLocal) {
                        const iDiffMs = dNowLocal.getTime() - dStartLocal.getTime();
                        const iDiffSeconds = Math.round(iDiffMs / 1000);

                        oOrder.timerState = {
                            elapsedSeconds: iDiffSeconds,
                            baseElapsedSeconds: iDiffSeconds,
                            isRunning: true,
                            clockInTime: dStartLocal.toISOString(),
                            timeEntryId: oEntry.SapUUID
                        };
                        bHasChanges = true;
                    }
                }
            });

            if (bHasChanges) {
                oOrdersModel.refresh();
            }
        },

        startGlobalTimerInterval: function () {
            if (this._timerInterval) return;

            this._timerInterval = setInterval(() => {
                const oOrdersModel = this.getOwnerComponent().getModel("orders");
                const aOrders = oOrdersModel.getProperty("/orders");
                const iNow = Date.now();
                let bAnyRunning = false;

                aOrders.forEach((oOrder, iIndex) => {
                    if (oOrder.timerState.isRunning && oOrder.timerState.clockInTime) {
                        bAnyRunning = true;

                        const iStartTime = new Date(oOrder.timerState.clockInTime).getTime();
                        const iTotalSeconds = Math.round((iNow - iStartTime) / 1000);

                        if (oOrder.timerState.elapsedSeconds !== iTotalSeconds) {
                            oOrdersModel.setProperty(`/orders/${iIndex}/timerState/elapsedSeconds`, iTotalSeconds);
                        }
                    }
                });

                if (!bAnyRunning) {
                    clearInterval(this._timerInterval);
                    this._timerInterval = null;
                }
            }, 1000);
        },

        onClockIn: async function (oEvent) {
            this._setBusy(true);
            const oContext = oEvent.getSource().getBindingContext("orders");
            const sOrderId = oContext.getProperty("orderId");
            const sOperationId = oContext.getProperty("operationId");
            const sActivityType = oContext.getProperty("activityType");

            const nowLocal = new Date();
            const sDateTimeOffset = nowLocal.toISOString();
            
            const cstIso = this._toCSTIsoString(nowLocal);
            const datePartCST = cstIso.slice(0, 10);
            const timePartCST = cstIso.slice(11, 19);

            const oPayload = {
                "OrderID": sOrderId,
                "OperationSo": sOperationId,
                "UserID": this.getCurrentUserId(),
                "ActTyp": sActivityType, 
                "ExecStartDate": datePartCST,
                "ExecStartTime": timePartCST,
                "ExecFinDate": datePartCST,
                "ExecFinTime": timePartCST,
                "ClkInLog": sDateTimeOffset,
                "Status": "InProcess"
            };

            try {
                const response = await this._authenticatedFetch(this.sHanaServiceUrl, "POST", oPayload);
                const data = await response.json();
                const sNewEntry = data.value ? data.value[0] : (data.d || data);
                const sTimeEntryUUID = sNewEntry.SapUUID || null;

                const oTimerState = oContext.getProperty("timerState");
                oTimerState.isRunning = true;
                oTimerState.clockInTime = nowLocal.toISOString();
                oTimerState.baseElapsedSeconds = 0;
                oTimerState.elapsedSeconds = 0;
                oTimerState.timeEntryId = sTimeEntryUUID;

                oContext.getModel().refresh();
                this.startGlobalTimerInterval();
                this.updatePanelVisibility();
                MessageToast.show("Clocked in");
            } catch (error) {
                MessageBox.error(error.message);
            } finally {
                this._setBusy(false);
            }
        },

        onClockOut: async function (oEvent) {
            this._setBusy(true);
            const oContext = oEvent.getSource().getBindingContext("orders");

            const sClockInTime = oContext.getProperty("timerState/clockInTime");
            const sTimeEntryUUID = oContext.getProperty("timerState/timeEntryId");
            const sActivityType = oContext.getProperty("activityType");

            const bIsActive = await this._verifyEntryStatus(sTimeEntryUUID, "InProcess");
            if (!bIsActive) {
                MessageBox.error("This entry was updated in another session. Refreshing data.", {
                    onClose: () => {
                        this.loadOrdersAndTimeEntries();
                        this.saveEntryToDrafts();
                    }
                });
                this._setBusy(false);
                return;
            }

            if (!sClockInTime || !sTimeEntryUUID) {
                MessageBox.error("No active timer found.");
                this._setBusy(false);
                return;
            }

            const nowLocal = new Date();
            const startLocal = new Date(sClockInTime);

            if (isNaN(startLocal.getTime())) {
                MessageBox.error("Invalid start time detected. Please refresh orders.");
                this._setBusy(false);
                return;
            }

            const iElapsedMs = nowLocal.getTime() - startLocal.getTime();
            const iTotalSeconds = Math.round(iElapsedMs / 1000);
            const fActualWorkHours = parseFloat((iTotalSeconds / 3600).toFixed(2));

            try {
                const oDialogModel = this.getView().getModel("dialog");
                oDialogModel.setData({
                    OrderID: oContext.getProperty("orderId"),
                    OperationSo: oContext.getProperty("operationId"),
                    ActivityType: sActivityType,
                    workStartDate: startLocal,
                    workFinishDate: nowLocal,
                    actualWork: fActualWorkHours,
                    elapsedSeconds: iTotalSeconds,
                    confirmationText: "",
                    isFinalConfirmation: false,
                    contextPath: oContext.getPath(),
                    timeEntryId: sTimeEntryUUID
                });

                this.openSubmitDialog();
            } catch (error) {
                MessageBox.error(error.message);
            } finally {
                this._setBusy(false);
            }
        },

        openSubmitDialog: function () {
            if (!this.oSubmitDialog) {
                Fragment.load({
                    name: "timetracker.view.fragment.SubmitDialog",
                    controller: this
                }).then((oDialog) => {
                    this.oSubmitDialog = oDialog;
                    this.getView().addDependent(this.oSubmitDialog);
                    this.oSubmitDialog.open();
                });
            } else {
                this.oSubmitDialog.open();
            }
        },

        onCloseDialog: function () {
            if (this.oSubmitDialog) {
                this.oSubmitDialog.close();
            }
            this.loadOrdersAndTimeEntries();
            this.saveEntryToDrafts();
        },

        onSubmitConfirmation: function () {
            const oDialogModel = this.getView().getModel("dialog");
            const oData = oDialogModel.getData();

            if (!oData.workStartDate || !oData.workFinishDate || oData.actualWork === undefined) {
                MessageBox.error("Please fill in all required fields.");
                return;
            }

            this._setBusy(true);
            this.postConfirmationToBAPI(oData);
        },

        postConfirmationToBAPI: async function (oData) {
            this._setBusy(true);
            if (this.oSubmitDialog) {
                this.oSubmitDialog.close();
            }

            const sEmployeeUrl = "/sap/bc/zfmcall/HR_GETEMPLOYEEDATA_FROMUSER";
            const sODataUrl = "/sap/opu/odata/sap/API_MAINTORDERCONFIRMATION/MaintOrderConfirmation";

            try {
                const employeeResponse = await fetch(sEmployeeUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username: this.getCurrentUserId() })
                });

                if (!employeeResponse.ok) throw new Error("Employee number not found");
                const employeeData = await employeeResponse.json();
                if (!employeeData || !employeeData.employeenumber || parseInt(employeeData.employeenumber, 10) === 0) {
                    throw new Error("Employee number not found");
                }
                const sPersonnelNumber = employeeData.employeenumber;

                await this._refreshCsrfToken();
                if (!this._sCsrfToken) throw new Error("Could not fetch CSRF Token");

                const oPrimaryPayload = this._buildConfirmationPayload(oData, sPersonnelNumber, false);
                 
                const responsePrimary = await fetch(sODataUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-CSRF-Token": this._sCsrfToken
                    },
                    body: JSON.stringify(oPrimaryPayload),
                    credentials: "include"
                });

                const responseDataPrimary = await responsePrimary.json();
                if (!responsePrimary.ok) {
                    throw new Error(this._extractErrorMessage(responseDataPrimary));
                }

                const resultPrimary = responseDataPrimary.d || responseDataPrimary;
                const sCnfNo = resultPrimary.MaintOrderConf;
                const sCnfCntr = resultPrimary.MaintOrderConfCntrValue;

                if (oData.contextPath) {
                    const oOrdersModel = this.getOwnerComponent().getModel("orders");
                    const oContext = oOrdersModel.createBindingContext(oData.contextPath);
                    this.stopSpecificTimer(oContext);
                }

                await this.updateTimeEntryOnServerByUUID(oData.timeEntryId, {
                    CnfNo: sCnfNo,
                    CnfCntr: sCnfCntr,
                    Status: "PrimaryDone",
                    workFinishDate: oData.workFinishDate,
                    ActWrk: parseFloat(oData.actualWork), 
                    Arbeh: "H" 
                });

                try {
                    const oOverheadPayload = this._buildConfirmationPayload(oData, sPersonnelNumber, true); 
                    
                    const responseOverhead = await fetch(sODataUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "X-CSRF-Token": this._sCsrfToken
                        },
                        body: JSON.stringify(oOverheadPayload),
                        credentials: "include"
                    });

                    const responseDataOverhead = await responseOverhead.json();
                    if (!responseOverhead.ok) {
                          throw new Error(this._extractErrorMessage(responseDataOverhead));
                    }

                    const resultOverhead = responseDataOverhead.d || responseDataOverhead;
                    
                    await this.updateTimeEntryOnServerByUUID(oData.timeEntryId, {
                        OcnfNo: resultOverhead.MaintOrderConf,
                        OcnfCntr: resultOverhead.MaintOrderConfCntrValue,
                        OvrHd: "X",
                        Status: "Completed"
                    });

                    sap.m.MessageBox.success(`Time & Overhead Saved Successfully!\nConf: ${sCnfNo}, Overhead: ${resultOverhead.MaintOrderConf}`, {
                        onClose: () => this.onCloseDialog()
                    });

                } catch (overheadError) {
                    await this.updateTimeEntryOnServerByUUID(oData.timeEntryId, {
                        Status: "OverheadError"
                    });
                    sap.m.MessageBox.warning(`Primary Confirmation Saved (${sCnfNo}), but Overhead failed: ${overheadError.message}. Please retry from Overhead Failures panel.`, {
                          onClose: () => this.onCloseDialog()
                    });
                }

            } catch (error) {
                sap.m.MessageBox.error(`Confirmation Failed: ${error.message}`);
                this.onCloseWithError(oData, "Error");
            } finally {
                this._setBusy(false);
            }
        },

        onPostOverheadFailure: async function(oEvent) {
             const oDraft = oEvent.getSource().getBindingContext("overheadFailures").getObject();
             
             const bValid = await this._verifyEntryStatus(oDraft.SapUUID, "OverheadError");
             if (!bValid) {
                 MessageBox.error("This entry was modified in another session. Refreshing data.", {
                     onClose: () => {
                         this.loadOrdersAndTimeEntries();
                         this.saveEntryToDrafts();
                     }
                 });
                 return;
             }

             this._setBusy(true);
             const sEmployeeUrl = "/sap/bc/zfmcall/HR_GETEMPLOYEEDATA_FROMUSER";

             try {
                const employeeResponse = await fetch(sEmployeeUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username: this.getCurrentUserId() })
                });

                if (!employeeResponse.ok) throw new Error("Employee number not found");
                const employeeData = await employeeResponse.json();
                const sPersonnelNumber = employeeData.employeenumber;

                await this._refreshCsrfToken();
                if (!this._sCsrfToken) throw new Error("Could not fetch CSRF Token");

                const dStart = this._parseServerCSTToLocalDate(oDraft.ExecStartDate, oDraft.ExecStartTime);
                const dEnd = this._parseServerCSTToLocalDate(oDraft.ExecFinDate, oDraft.ExecFinTime);
                const iDiffMs = dEnd.getTime() - dStart.getTime();
                const iTotalSeconds = Math.round(iDiffMs / 1000);
                
                const fActualWork = parseFloat(oDraft.ActWrk);

                const oData = {
                    OrderID: oDraft.OrderID,
                    OperationSo: oDraft.OperationSo,
                    workStartDate: dStart,
                    workFinishDate: dEnd,
                    actualWork: fActualWork,
                    elapsedSeconds: iTotalSeconds,
                    isFinalConfirmation: false,
                    confirmationText: ""
                };

                const oOverheadPayload = this._buildConfirmationPayload(oData, sPersonnelNumber, true);
                const sODataUrl = "/sap/opu/odata/sap/API_MAINTORDERCONFIRMATION/MaintOrderConfirmation";

                const responseOverhead = await fetch(sODataUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-CSRF-Token": this._sCsrfToken
                    },
                    body: JSON.stringify(oOverheadPayload),
                    credentials: "include"
                });

                const responseDataOverhead = await responseOverhead.json();
                if (!responseOverhead.ok) {
                      throw new Error(this._extractErrorMessage(responseDataOverhead));
                }

                const resultOverhead = responseDataOverhead.d || responseDataOverhead;
                
                await this.updateTimeEntryOnServerByUUID(oDraft.SapUUID, {
                    OcnfNo: resultOverhead.MaintOrderConf,
                    OcnfCntr: resultOverhead.MaintOrderConfCntrValue,
                    OvrHd: "X",
                    Status: "Completed"
                });

                MessageToast.show(`Overhead Confirmed: ${resultOverhead.MaintOrderConf}`);
                this.saveEntryToDrafts();

             } catch (e) {
                 MessageBox.error("Overhead Retry Failed: " + e.message);
             } finally {
                 this._setBusy(false);
             }
        },

        _buildConfirmationPayload: function(oData, sPersonnelNumber, bIsOverhead) {
            const sOrderId = String(oData.OrderID).padStart(12, "0");
            const sOperation = String(oData.OperationSo).padStart(4, "0");
            const startCSTIso = this._toCSTIsoString(oData.workStartDate);
            const finishCSTIso = this._toCSTIsoString(oData.workFinishDate);

            const toODataDate = (iso) => {
                const y = parseInt(iso.substring(0, 4), 10);
                const m = parseInt(iso.substring(5, 7), 10) - 1;
                const d = parseInt(iso.substring(8, 10), 10);
                const h = parseInt(iso.substring(11, 13), 10);
                const min = parseInt(iso.substring(14, 16), 10);
                const s = parseInt(iso.substring(17, 19), 10);
                return `/Date(${Date.UTC(y, m, d, h, min, s)})/`;
            };

            const toODataTime = (iso) => {
                const timePart = iso.slice(11, 19);
                const [h, m, s] = timePart.split(':');
                return `PT${h}H${m}M${s}S`;
            };

            let sActualWork = parseFloat(oData.actualWork || 0).toFixed(1);
            if (parseFloat(sActualWork) === 0.0 && oData.elapsedSeconds > 60) {
                sActualWork = "0.1";
            }

            const oPayload = {
                "MaintenanceOrder": sOrderId,
                "MaintenanceOrderOperation": sOperation,
                "PersonnelNumber": sPersonnelNumber,
                "ActualWorkQuantity": sActualWork,
                "ActualWorkQuantityUnit": "H",
                "IsFinalConfirmation": oData.isFinalConfirmation || false,
                "ConfirmationText": oData.confirmationText || "",
                "PostingDate": toODataDate(this._toCSTIsoString(new Date())),
                "OperationConfirmedStartDate": toODataDate(startCSTIso),
                "OperationConfirmedStartTime": toODataTime(startCSTIso),
                "OperationConfirmedEndDate": toODataDate(finishCSTIso),
                "OperationConfirmedEndTime": toODataTime(finishCSTIso),
                "ActivityType":oData.ActivityType
            };

            if (bIsOverhead) {
                oPayload.ActivityType = "OVRHD"; 
                oPayload.ConfirmationText = "Overhead: " + (oData.confirmationText || "");
            }

            return oPayload;
        },

        _extractErrorMessage: function(responseData) {
            let sErrorMessage = "Unknown Error";
            try {
                if (responseData.error && responseData.error.message) {
                    sErrorMessage = responseData.error.message.value;
                }
                if (responseData.error?.innererror?.errordetails?.length > 0) {
                    const firstErr = responseData.error.innererror.errordetails.find(d => d.severity === "error");
                    if (firstErr) sErrorMessage = firstErr.message;
                }
            } catch (e) { }
            return sErrorMessage;
        },

        _authenticatedFetch: async function (url, method = "GET", body = null, isRetry = false) {
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (method !== "GET") {
                if (!this._sCsrfToken) await this._refreshCsrfToken();
                if (this._sCsrfToken) headers['X-CSRF-Token'] = this._sCsrfToken;
            }

            const options = { method: method, headers: headers, credentials: 'include' };
            if (body) options.body = JSON.stringify(body);

            try {
                const response = await fetch(url, options);
                if ((response.status === 403 || response.headers.get("x-csrf-token") === "Required") && !isRetry) {
                    await this._refreshCsrfToken();
                    return this._authenticatedFetch(url, method, body, true);
                }
                if (!response.ok) {
                    const txt = await response.text();
                    throw new Error(`HTTP ${response.status}: ${txt}`);
                }
                return response;
            } catch (error) { throw error; }
        },

        _refreshCsrfToken: async function () {
            try {
                const response = await fetch(this.sHanaServiceUrl, {
                    method: "GET",
                    headers: { "X-CSRF-Token": "Fetch", "Accept": "application/json" },
                    credentials: 'include'
                });
                const token = response.headers.get("X-CSRF-Token");
                if (token) this._sCsrfToken = token;
            } catch (e) { console.error("CSRF Fetch Error", e); }
        },

        updateTimeEntryOnServerByUUID: async function (sSapUUID, oAttributes) {
            this._setBusy(true);
            const sEntryUrl = `${this.sHanaServiceUrl}(${encodeURIComponent(sSapUUID)})`;

            try {
                if (!this._sCsrfToken) await this._refreshCsrfToken();

                const oPayload = { ...oAttributes }; 
                
                if (oAttributes.workStartDate) {
                    const cst = this._toCSTIsoString(oAttributes.workStartDate);
                    oPayload.ExecStartDate = cst.slice(0, 10);
                    oPayload.ExecStartTime = cst.slice(11, 19);
                    delete oPayload.workStartDate;
                }
                if (oAttributes.workFinishDate) {
                    const cst = this._toCSTIsoString(oAttributes.workFinishDate);
                    oPayload.ExecFinDate = cst.slice(0, 10);
                    oPayload.ExecFinTime = cst.slice(11, 19);
                    
                    oPayload.ClkOutLog = oAttributes.workFinishDate.toISOString();

                    delete oPayload.workFinishDate;
                }

                const resHead = await this._authenticatedFetch(sEntryUrl, "GET");
                const oData = await resHead.json();
                const eTag = resHead.headers.get("ETag") || (oData.d?.__metadata?.etag) || (oData['@odata.etag']);

                await fetch(sEntryUrl, {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": this._sCsrfToken,
                        "If-Match": eTag || "*"
                    },
                    body: JSON.stringify(oPayload),
                    credentials: 'include'
                });

            } catch (e) {
                console.error("Error updating time entry on server:", e);
                throw e;
            } finally {
                this._setBusy(false);
            }
        },

        stopSpecificTimer: function (oContext) {
            const sPath = oContext.getPath();
            oContext.getModel().setProperty(`${sPath}/timerState`, {
                elapsedSeconds: 0,
                baseElapsedSeconds: 0,
                isRunning: false,
                clockInTime: null,
                timeEntryId: null
            });
            this.updatePanelVisibility();
        },

        updatePanelVisibility: function () {
            const aOrders = this.getOwnerComponent().getModel("orders").getProperty("/orders");
            const bVisible = aOrders.some(o => o.timerState.isRunning);
            this.getOwnerComponent().getModel("viewState").setProperty("/isProgressPanelVisible", bVisible);
        },

        onSearchOrders: function () {
            const oSearchField = this.byId("orderIdSearch");
            const sQuery = oSearchField ? oSearchField.getValue().trim() : "";
            if (this._filterDebounceTimer) clearTimeout(this._filterDebounceTimer);
            this._filterDebounceTimer = setTimeout(() => {
                if (!sQuery || sQuery.length < 3) {
                    this.loadOrdersAndTimeEntries();
                } else {
                    this.loadOrdersAndTimeEntriesFiltered(sQuery);
                }
            }, 400);
        },

        loadOrdersAndTimeEntriesFiltered: async function (sOrderIdFilter) {
            this._setBusy(true);
            try {
                let sFilter = "MaintOrderCreationDateTime gt datetimeoffset'2025-06-01T00:00:00Z' and MaintenanceOrderType eq 'EREF'";
                if (sOrderIdFilter && sOrderIdFilter.length > 0) {
                    sFilter += ` and substringof('${sOrderIdFilter}', MaintenanceOrder)`;
                }
                const sUrl = `/sap/opu/odata/sap/API_MAINTENANCEORDER;v=2/MaintenanceOrder?$filter=${encodeURIComponent(sFilter)}&$expand=to_MaintenanceOrderOperation&$format=json`;

                const response = await this._authenticatedFetch(sUrl);
                const data = await response.json();
                let aOrdersRaw = data.d ? data.d.results : [];

                aOrdersRaw = aOrdersRaw.filter(oOrder => {
                    const bOrderMatches = oOrder.SystemStatusText && oOrder.SystemStatusText.startsWith("REL");
                    if (bOrderMatches) {
                        if (oOrder.to_MaintenanceOrderOperation && oOrder.to_MaintenanceOrderOperation.results) {
                            oOrder.to_MaintenanceOrderOperation.results = oOrder.to_MaintenanceOrderOperation.results.filter(oOp => {
                                return !oOp.SystemStatusText || !oOp.SystemStatusText.startsWith("CNF");
                            });
                        }
                        return true;
                    }
                    return false;
                });

                const aFlatOrders = this._processOrders(aOrdersRaw);
                this.getOwnerComponent().getModel("orders").setProperty("/orders", aFlatOrders);
                const aTimeEntries = await this.fetchActiveTimeEntries();
                this.mergeTimeEntriesWithOrders(aTimeEntries);
                this.startGlobalTimerInterval();
                this.updatePanelVisibility();
            } catch (err) {
                MessageBox.error(err.message);
            } finally {
                this._setBusy(false);
            }
        },

        onRefreshOrders: function () {
            MessageToast.show("Refreshing orders...");
            this.loadOrdersAndTimeEntries();
        },

        onSelectOrder: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext("orders");
            if (oContext.getProperty("timerState/isRunning")) return;

            const sOrderId = oContext.getProperty("orderId");
            const sOperationId = oContext.getProperty("operationId");
            const oActiveTimerModel = this.getView().getModel("activeTimer");

            if (oActiveTimerModel.getProperty("/activeOrderId") === sOrderId &&
                oActiveTimerModel.getProperty("/activeOperationId") === sOperationId) {
                oActiveTimerModel.setProperty("/activeOrderId", null);
                oActiveTimerModel.setProperty("/activeOperationId", null);
            } else {
                oActiveTimerModel.setProperty("/activeOrderId", sOrderId);
                oActiveTimerModel.setProperty("/activeOperationId", sOperationId);
            }
        },

        onClose: function () {
            const oDialogModel = this.getView().getModel("dialog");
            const oData = oDialogModel.getData();
            this.onCloseWithError(oData, "Error");
        },

        onCloseWithError: async function (oData, sStatus) {
            if (oData.contextPath && oData.timeEntryId) {
                const oOrdersModel = this.getOwnerComponent().getModel("orders");
                const oContext = oOrdersModel.createBindingContext(oData.contextPath);
                this.stopSpecificTimer(oContext);

                await this.updateTimeEntryOnServerByUUID(
                    oData.timeEntryId,
                    {
                        workStartDate: oData.workStartDate,
                        workFinishDate: oData.workFinishDate,
                        Status: sStatus
                    }
                );
            }
            this.onCloseDialog();
        },

        removeLeadingZeros: function (sOrderId) {
            if (!sOrderId) return "";
            return parseInt(sOrderId, 10).toString();
        },

        formatTime: function (iTotalSeconds) {
            if (iTotalSeconds == null) return "00:00:00";
            let h = Math.floor(iTotalSeconds / 3600);
            let m = Math.floor((iTotalSeconds % 3600) / 60);
            let s = iTotalSeconds % 60;
            return [h, m, s].map(v => v < 10 ? "0" + v : v).join(":");
        },

        _formatDate: function (input) {
            if (!input) return "";
            const ms = Number(input.match(/(\d+)/)[0]);
            return new Date(ms).toISOString().slice(0, 19);
        },

        saveEntryToDrafts: async function () {
            const sUserId = this.getCurrentUserId();
            const sUrl = `${this.sHanaServiceUrl}?$filter=UserID eq '${sUserId}'&$format=json`;
            try {
                const response = await this._authenticatedFetch(sUrl);
                const data = await response.json();
                const aAllResults = data.value || (data.d ? data.d.results : []);
                
                const processEntry = (item) => {
                    const dStart = this._parseServerCSTToLocalDate(item.ExecStartDate, item.ExecStartTime);
                    const dEnd = this._parseServerCSTToLocalDate(item.ExecFinDate, item.ExecFinTime);
                    if (dStart && dEnd) {
                        const diff = (dEnd - dStart) / 1000;
                        item.actualWorkHours = parseFloat((diff / 3600).toFixed(2));
                        let h = Math.floor(diff / 3600);
                        let m = Math.floor((diff % 3600) / 60);
                        item.formattedTime = `${h}:${m < 10 ? '0' + m : m}`;
                    } else {
                        item.formattedTime = "--:--";
                        item.actualWorkHours = 0;
                    }
                    return item;
                };

                const aErrorEntries = aAllResults.filter(item => item.Status === 'Error').map(processEntry);
                const aOverheadErrorEntries = aAllResults.filter(item => item.Status === 'OverheadError').map(processEntry);

                this.getOwnerComponent().getModel("drafts").setProperty("/entries", aErrorEntries);
                this.getOwnerComponent().getModel("overheadFailures").setProperty("/entries", aOverheadErrorEntries);

            } catch (e) {
                console.error("Failed to load drafts:", e);
            }
        },

        onPostDraft: async function (oEvent) {
            const oDraft = oEvent.getSource().getBindingContext("drafts").getObject();
            
            const bValid = await this._verifyEntryStatus(oDraft.SapUUID, "Error");
            if (!bValid) {
                 MessageBox.error("This entry was modified in another session. Refreshing data.", {
                     onClose: () => {
                         this.loadOrdersAndTimeEntries();
                         this.saveEntryToDrafts();
                     }
                 });
                 return;
            }

            const dStart = this._parseServerCSTToLocalDate(oDraft.ExecStartDate, oDraft.ExecStartTime);
            const dEnd = this._parseServerCSTToLocalDate(oDraft.ExecFinDate, oDraft.ExecFinTime);
            const iDiffMs = dEnd.getTime() - dStart.getTime();
            const iTotalSeconds = Math.round(iDiffMs / 1000);

            const oDialogData = {
                OrderID: oDraft.OrderID,
                OperationSo: oDraft.OperationSo,
                ActivityType: oDraft.ActTyp,
                workStartDate: dStart,
                workFinishDate: dEnd,
                actualWork: oDraft.actualWorkHours,
                elapsedSeconds: iTotalSeconds,
                confirmationText: "",
                isFinalConfirmation: false,
                timeEntryId: oDraft.SapUUID,
                contextPath: null
            };

            this.getView().getModel("dialog").setData(oDialogData);
            this.openSubmitDialog();
        },

        onDeleteDraft: async function (oEvent) {
            const sModelName = oEvent.getSource().getBindingContext("overheadFailures") ? "overheadFailures" : "drafts";
            const oContext = oEvent.getSource().getBindingContext(sModelName);
            const oDraft = oContext.getObject();

            const sExpectedStatus = sModelName === "overheadFailures" ? "OverheadError" : "Error";
            const bValid = await this._verifyEntryStatus(oDraft.SapUUID, sExpectedStatus);
            
            if (!bValid) {
                 MessageBox.error("This entry was modified in another session. Refreshing data.", {
                     onClose: () => {
                         this.loadOrdersAndTimeEntries();
                         this.saveEntryToDrafts();
                     }
                 });
                 return;
            }

            MessageBox.confirm("Permanently delete draft?", {
                onClose: async (sAction) => {
                    if (sAction === MessageBox.Action.OK) {
                        try {
                            await this.updateTimeEntryOnServerByUUID(oDraft.SapUUID, { Status: "Deleted" });
                            this.saveEntryToDrafts();
                            MessageToast.show("Draft deleted");
                        } catch (e) { MessageBox.error(e.message); }
                    }
                }
            });
        }
    });
});