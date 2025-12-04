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
        filterDebounceTimer: null,
        sHanaServiceUrl: "/sap/opu/odata4/sap/zapi_cs_cio_tt_o4/srvd_a2x/sap/zapi_cs_cio_tt_o4/0001/ZC_CS_CIO_TT",

        onInit: function () {
            this._initModels();
            this._initializeUserId().then(() => {
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
                contextPath: null,
                timeEntryId: null
            }), "dialog");

            const oComponent = this.getOwnerComponent();
            oComponent.setModel(new JSONModel({ isProgressPanelVisible: false }), "viewState");
            oComponent.setModel(new JSONModel({ entries: [] }), "drafts");
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

        _authenticatedFetch: async function (url, method = "GET", body = null, isRetry = false) {
            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            };

            if (method !== "GET") {
                if (!this._sCsrfToken) {
                    await this._refreshCsrfToken();
                }
                if (this._sCsrfToken) {
                    headers['X-CSRF-Token'] = this._sCsrfToken;
                }
            }

            const options = {
                method: method,
                headers: headers,
                credentials: 'include'
            };

            if (body) {
                options.body = JSON.stringify(body);
            }

            try {
                const response = await fetch(url, options);
                const isForbidden = response.status === 403;
                const isCsrfError = response.headers.get("x-csrf-token") === "Required";

                if (isForbidden && isCsrfError && !isRetry) {
                    await this._refreshCsrfToken();
                    return this._authenticatedFetch(url, method, body, true);
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }
                return response;
            } catch (error) {
                throw error;
            }
        },

        _refreshCsrfToken: async function () {
            try {
                const response = await fetch(this.sHanaServiceUrl, {
                    method: "GET",
                    headers: {
                        "X-CSRF-Token": "Fetch",
                        "Accept": "application/json"
                    },
                    credentials: 'include'
                });
                const token = response.headers.get("X-CSRF-Token");
                if (token) {
                    this._sCsrfToken = token;
                }
            } catch (e) {
                console.error("Failed to fetch CSRF token:", e);
            }
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

        loadOrdersAndTimeEntries: async function () {
            this._setBusy(true);
            try {
                const sFilter = "MaintOrderCreationDateTime gt datetimeoffset'2025-06-01T00:00:00Z' and MaintenanceOrderType eq 'EREF'";
                const sUrl = `/sap/opu/odata/sap/API_MAINTENANCEORDER;v=2/MaintenanceOrder?$filter=${encodeURIComponent(sFilter)}&$expand=to_MaintenanceOrderOperation&$format=json`;

                const response = await this._authenticatedFetch(sUrl);
                const data = await response.json();
                const aOrdersRaw = data.d ? data.d.results : [];

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
                const aOrdersRaw = data.d ? data.d.results : [];

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
                return aAllResults.filter(item => item.Status === 'InProcess' || item.Status === 'Error');
            } catch (e) {
                console.error("Failed to fetch active time entries:", e);
                return [];
            }
        },

        mergeTimeEntriesWithOrders: function (aTimeEntries) {
            const oOrdersModel = this.getOwnerComponent().getModel("orders");
            const aOrders = oOrdersModel.getProperty("/orders");
            let bHasChanges = false;

            const sNowCST = this._toCSTIsoString(new Date());
            const dNowCST = new Date(sNowCST);

            aTimeEntries.forEach(oEntry => {
                if (oEntry.Status !== 'InProcess') return;

                const oOrder = aOrders.find(o =>
                    String(parseInt(o.orderId, 10)) === String(parseInt(oEntry.OrderID, 10)) &&
                    String(parseInt(o.operationId, 10)) === String(parseInt(oEntry.OperationSo, 10))
                );

                if (oOrder) {
                    const sSapStartIso = `${oEntry.ExecStartDate}T${oEntry.ExecStartTime}`;
                    const dSapStartCST = new Date(sSapStartIso);

                    const iDiffSeconds = Math.round((dNowCST.getTime() - dSapStartCST.getTime()) / 1000);
                    const nowLocal = new Date();
                    const dLocalClockIn = new Date(nowLocal.getTime() - (iDiffSeconds * 1000));

                    oOrder.timerState = {
                        elapsedSeconds: iDiffSeconds,
                        baseElapsedSeconds: iDiffSeconds,
                        isRunning: true,
                        clockInTime: dLocalClockIn.toISOString(),
                        timeEntryId: oEntry.SapUUID
                    };
                    bHasChanges = true;
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
                        const iBase = oOrder.timerState.baseElapsedSeconds || 0;
                        const iTotalSeconds = Math.round(((iNow - iStartTime) / 1000));

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

            const nowLocal = new Date();
            const cstIso = this._toCSTIsoString(nowLocal);
            const datePartCST = cstIso.slice(0, 10);
            const timePartCST = cstIso.slice(11, 19);

            const oPayload = {
                "OrderID": sOrderId,
                "OperationSo": sOperationId,
                "UserID": this.getCurrentUserId(),
                "ExecStartDate": datePartCST,
                "ExecStartTime": timePartCST,
                "ExecFinDate": datePartCST,
                "ExecFinTime": timePartCST,
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
            const iBaseElapsed = oContext.getProperty("timerState/baseElapsedSeconds") || 0;

            if (!sClockInTime || !sTimeEntryUUID) {
                MessageBox.error("No active timer found.");
                this._setBusy(false);
                return;
            }

            const nowLocal = new Date();
            const startLocal = new Date(sClockInTime);

            const iElapsedMs = nowLocal.getTime() - startLocal.getTime();
            const iSessionSeconds = Math.round(iElapsedMs / 1000);
            const iTotalSeconds = iBaseElapsed + iSessionSeconds;

            const dEffectiveStartLocal = new Date(nowLocal.getTime() - (iTotalSeconds * 1000));
            const fActualWorkHours = parseFloat((iTotalSeconds / 3600).toFixed(2));

            try {
                const oDialogModel = this.getView().getModel("dialog");
                oDialogModel.setData({
                    OrderID: oContext.getProperty("orderId"),
                    OperationSo: oContext.getProperty("operationId"),
                    workStartDate: dEffectiveStartLocal,
                    workFinishDate: nowLocal,
                    actualWork: fActualWorkHours,
                    elapsedSeconds: iTotalSeconds,
                    confirmationText: oContext.getProperty("orderDesc") || "",
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

            const sODataUrl = "/sap/opu/odata/sap/API_MAINTORDERCONFIRMATION/MaintOrderConfirmation";

            try {
                const fetchResponse = await fetch(sODataUrl, {
                    method: "GET",
                    headers: {
                        "X-CSRF-Token": "Fetch",
                        "Accept": "application/json"
                    },
                    credentials: "include"
                });

                const sToken = fetchResponse.headers.get("x-csrf-token");
                if (!sToken) {
                    throw new Error("Could not fetch CSRF Token from API_MAINTORDERCONFIRMATION");
                }

                const sOrderId = String(oData.OrderID).padStart(12, "0");
                const sOperation = String(oData.OperationSo).padStart(4, "0");

                const startCSTIso = this._toCSTIsoString(oData.workStartDate);
                const finishCSTIso = this._toCSTIsoString(oData.workFinishDate);

                const toODataDate = (iso) => {
                    const timestamp = new Date(iso).getTime();
                    return `/Date(${timestamp})/`;
                };

                const toODataTime = (iso) => {
                    const timePart = iso.slice(11, 19);
                    const [h, m, s] = timePart.split(':');
                    return `PT${h}H${m}M${s}S`;
                };

                let sActualWork = parseFloat(oData.actualWork || 0).toFixed(1);
                if (sActualWork === "0.0" && oData.elapsedSeconds > 0) {
                    sActualWork = "0.1";
                }

                const oPayload = {
                    "MaintenanceOrder": sOrderId,
                    "MaintenanceOrderOperation": sOperation,
                    "PersonnelNumber": "00000000",
                    "ActualWorkQuantity": sActualWork,
                    "ActualWorkQuantityUnit": "H",
                    "IsFinalConfirmation": false,
                    "ConfirmationText": oData.confirmationText || "Confirmed via App",
                    "PostingDate": toODataDate(finishCSTIso),
                    "OperationConfirmedStartDate": toODataDate(startCSTIso),
                    "OperationConfirmedStartTime": toODataTime(startCSTIso),
                    "OperationConfirmedEndDate": toODataDate(finishCSTIso),
                    "OperationConfirmedEndTime": toODataTime(finishCSTIso)
                };

                const sPostUrl = sODataUrl;

                const response = await fetch(sPostUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-CSRF-Token": sToken
                    },
                    body: JSON.stringify(oPayload),
                    credentials: "include"
                });

                const responseData = await response.json();

                if (response.ok) {
                    const result = responseData.d || responseData;
                    const sConfNum = result.MaintOrderConf;
                    const sConfCntr = result.MaintOrderConfCntrValue;

                    sap.m.MessageBox.success(
                        `Saved Successfully!\nConfirmation #: ${sConfNum}\nCounter: ${sConfCntr}`,
                        {
                            onClose: async () => {
                                if (oData.contextPath && oData.timeEntryId) {
                                    const oOrdersModel = this.getOwnerComponent().getModel("orders");
                                    const oContext = oOrdersModel.createBindingContext(oData.contextPath);
                                    this.stopSpecificTimer(oContext);
                                }

                                if (oData.timeEntryId) {
                                    await this.updateTimeEntryOnServerByUUID(
                                        oData.timeEntryId,
                                        oData.workFinishDate,
                                        "Completed"
                                    );
                                }
                                this.onCloseDialog();
                            }
                        }
                    );

                } else {
                    let sErrorMessage = "Unknown Error";

                    try {
                        if (responseData.error && responseData.error.message) {
                            sErrorMessage = responseData.error.message.value;
                        }

                        if (responseData.error && responseData.error.innererror && responseData.error.innererror.errordetails) {
                            const details = responseData.error.innererror.errordetails;
                            if (details.length > 0) {
                                const firstDetail = details.find(d => d.severity === "error");
                                if (firstDetail) {
                                    sErrorMessage = firstDetail.message;
                                }
                            }
                        }
                    } catch (e) {
                        sErrorMessage = "Failed to parse error response.";
                    }

                    throw new Error(sErrorMessage);
                }

            } catch (error) {
                sap.m.MessageBox.error(`Confirmation Failed: ${error.message}`);
                this.onCloseWithError(oData);
            } finally {
                this._setBusy(false);
            }
        },

        updateTimeEntryOnServerByUUID: async function (sSapUUID, finishDateLocal, sStatus) {
            this._setBusy(true);
            const sEntryUrl = `${this.sHanaServiceUrl}(${encodeURIComponent(sSapUUID)})`;

            try {
                if (!this._sCsrfToken) await this._refreshCsrfToken();

                const oPayload = { Status: sStatus };
                if (finishDateLocal) {
                    const cstIso = this._toCSTIsoString(finishDateLocal);
                    oPayload.ExecFinDate = cstIso.slice(0, 10);
                    oPayload.ExecFinTime = cstIso.slice(11, 19);
                }

                const resHead = await this._authenticatedFetch(sEntryUrl, "GET");
                const oData = await resHead.json();
                const eTag = resHead.headers.get("ETag") || (oData.d && oData.d.__metadata ? oData.d.__metadata.etag : null);

                await fetch(sEntryUrl, {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": this._sCsrfToken,
                        "If-Match": eTag
                    },
                    body: JSON.stringify(oPayload),
                    credentials: 'include'
                });

            } catch (e) {
                console.error("Error updating time entry status on server:", e);
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

            if (this.filterDebounceTimer) {
                clearTimeout(this.filterDebounceTimer);
            }
            this.filterDebounceTimer = setTimeout(() => {
                if (!sQuery || sQuery.length < 3) {
                    this.loadOrdersAndTimeEntries();
                } else {
                    this.loadOrdersAndTimeEntriesFiltered(sQuery);
                }
            }, 400);
        },

        onRefreshOrders: function () {
            MessageToast.show("Refreshing orders...");
            this.loadOrdersAndTimeEntries();
        },

        onSelectOrder: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext("orders");
            const sOrderId = oContext.getProperty("orderId");
            const sOperationId = oContext.getProperty("operationId");

            const oActiveTimerModel = this.getView().getModel("activeTimer");
            const sCurrentActiveId = oActiveTimerModel.getProperty("/activeOrderId");
            const sCurrentActiveOp = oActiveTimerModel.getProperty("/activeOperationId");

            if (oContext.getProperty("timerState/isRunning")) return;

            if (sCurrentActiveId === sOrderId && sCurrentActiveOp === sOperationId) {
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
            this.onCloseWithError(oData);
        },

        onCloseWithError: async function (oData) {
            if (oData.contextPath && oData.timeEntryId) {
                const oOrdersModel = this.getOwnerComponent().getModel("orders");
                const oContext = oOrdersModel.createBindingContext(oData.contextPath);
                this.stopSpecificTimer(oContext);

                try {
                    await this.updateTimeEntryOnServerByUUID(
                        oData.timeEntryId,
                        oData.workFinishDate,
                        "Error"
                    );
                } catch (e) {
                    console.error("Failed to mark time entry as Error on server:", e);
                }
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

        formatDateForBAPI: function (oDate) {
            if (!oDate) return "";
            var d = new Date(oDate);
            var year = d.getFullYear();
            var month = ("0" + (d.getMonth() + 1)).slice(-2);
            var day = ("0" + d.getDate()).slice(-2);
            return year + "-" + month + "-" + day;
        },

        saveEntryToDrafts: async function () {
            const sUserId = this.getCurrentUserId();
            const sUrl = `${this.sHanaServiceUrl}?$filter=UserID eq '${sUserId}'&$format=json`;

            try {
                const response = await this._authenticatedFetch(sUrl);
                const data = await response.json();
                const aAllResults = data.value || (data.d ? data.d.results : []);

                const aErrorEntries = aAllResults.filter(item => item.Status === 'Error');

                aErrorEntries.forEach(item => {
                    try {
                        const sStart = `${item.ExecStartDate}T${item.ExecStartTime}`;
                        const sEnd = `${item.ExecFinDate}T${item.ExecFinTime}`;
                        const diff = (new Date(sEnd) - new Date(sStart)) / 1000;
                        const h = Math.floor(diff / 3600);
                        const m = Math.floor((diff % 3600) / 60);
                        item.formattedTime = `${h}:${m < 10 ? '0' + m : m}`;
                        item.actualWorkHours = parseFloat((diff / 3600).toFixed(2));
                    } catch (e) {
                        item.formattedTime = "--:--";
                        item.actualWorkHours = 0;
                    }
                });

                this.getOwnerComponent().getModel("drafts").setProperty("/entries", aErrorEntries);
            } catch (e) {
                console.error("Failed to load drafts:", e);
            }
        },

        onPostDraft: function (oEvent) {
            const oDraft = oEvent.getSource().getBindingContext("drafts").getObject();

            const oData = {
                OrderID: oDraft.OrderID,
                OperationSo: oDraft.OperationSo,
                workStartDate: new Date(`${oDraft.ExecStartDate}T${oDraft.ExecStartTime}`),
                workFinishDate: new Date(`${oDraft.ExecFinDate}T${oDraft.ExecFinTime}`),
                actualWork: oDraft.actualWorkHours,
                confirmationText: "Draft Retry",
                timeEntryId: oDraft.SapUUID,
                contextPath: null
            };

            this._setBusy(true);
            this.postConfirmationToBAPI(oData);
        },

        onDeleteDraft: function (oEvent) {
            const oContext = oEvent.getSource().getBindingContext("drafts");
            const oDraft = oContext.getObject();

            MessageBox.confirm("Are you sure you want to permanently delete this draft entry?", {
                onClose: async (sAction) => {
                    if (sAction === MessageBox.Action.OK) {
                        try {
                            this._setBusy(true);
                            await this.updateTimeEntryOnServerByUUID(oDraft.SapUUID, null, "Deleted");
                            this.saveEntryToDrafts();
                            MessageToast.show("Draft deleted");
                        } catch (e) {
                            MessageBox.error("Failed to delete draft: " + e.message);
                        } finally {
                            this._setBusy(false);
                        }
                    }
                }
            });
        },

        _toLocalIsoString: function (date) {
            const pad = function (num) { return (num < 10 ? '0' : '') + num; };
            return date.getFullYear() +
                '-' + pad(date.getMonth() + 1) +
                '-' + pad(date.getDate()) +
                'T' + pad(date.getHours()) +
                ':' + pad(date.getMinutes()) +
                ':' + pad(date.getSeconds());
        }
    });
});