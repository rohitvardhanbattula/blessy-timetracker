sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, Fragment) {
    "use strict";

    return Controller.extend("timetracker.controller.View1", {

        _timerInterval: null,
        _oSubmitDialog: null,
        sHanaServiceUrl: "/sap/opu/odata4/sap/zapi_cs_cio_o4/srvd_a2x/sap/zapi_cs_cio_o4/0001/ZC_CS_CIO",

        formatDate: function (input) {
            if (!input) return "";
            const ms = Number(input.match(/\d+/)[0]);
            const date = new Date(ms);
            return date.toISOString().slice(0, 19);
        },
        getCurrentUserId: function () {
            return this.sUserIdFLP || 'RBATTULA';
        },

        onInit: function () {
            var that = this;


            if (sap.ushell && sap.ushell.Container) {
                sap.ushell.Container.getServiceAsync("UserInfo").then(function (oUserInfo) {
                    that.sUserIdFLP = oUserInfo.getId();
                }).catch(function () {
                    that.sUserIdFLP = 'RBATTULA';
                });
            } else {
                that.sUserIdFLP = 'RBATTULA';
            }
            var oBusyModel = new JSONModel({ busy: false });
            this.getView().setModel(oBusyModel, "busy");

            var oActiveTimerModel = new JSONModel({ activeOrderId: null, activeOperationId: null });
            this.getView().setModel(oActiveTimerModel, "activeTimer");

            var oDialogModel = new JSONModel({
                orderId: null,
                operationId: null,
                workStartDate: null,
                workFinishDate: null,
                actualWork: "0.0",
                confirmationText: "",
                isFinalConfirmation: false,
                contextPath: null,
                timeEntryId: null,
                elapsedSeconds: 0
            });
            this.getView().setModel(oDialogModel, "dialog");

            var oViewStateModel = new JSONModel({ isProgressPanelVisible: false });
            this.getOwnerComponent().setModel(oViewStateModel, "viewState");

            var oDraftsModel = new JSONModel({ entries: [] });
            this.getOwnerComponent().setModel(oDraftsModel, "drafts");

            this.saveEntryToDrafts();
            this.loadOrdersAndTimeEntries();
        },

        removeLeadingZeros: function (sOrderId) {
            if (!sOrderId) return "";
            return parseInt(sOrderId, 10).toString();
        },

        formatTime: function (iTotalSeconds) {
            if (iTotalSeconds === null || iTotalSeconds === undefined) return "00:00:00";
            let h = Math.floor(iTotalSeconds / 3600);
            let m = Math.floor((iTotalSeconds % 3600) / 60);
            let s = iTotalSeconds % 60;
            return [h, m, s].map(v => (v < 10 ? "0" : "") + v).join(":");
        },

        async loadOrdersAndTimeEntries() {
            this.getView().getModel("busy").setProperty("/busy", true);
            try {
                const sFilter = "MaintOrderCreationDateTime gt datetimeoffset'2025-06-01T00:00:00Z' and MaintenanceOrderType eq 'EREF'";
                const sUrl = "/sap/opu/odata/sap/API_MAINTENANCEORDER;v=2/MaintenanceOrder?$filter=" +
                    encodeURIComponent(sFilter) + "&$expand=to_MaintenanceOrderOperation&$format=json";

                const response = await fetch(sUrl);
                if (!response.ok) {
                    throw new Error("Failed to fetch orders");
                }
                const data = await response.json();
                const aOrdersRaw = data.d && data.d.results ? data.d.results : [];

                const aFlatOrders = [];

                aOrdersRaw.forEach(order => {
                    const aOperations = order.to_MaintenanceOrderOperation ? order.to_MaintenanceOrderOperation.results : [];
                    aOperations.forEach(op => {
                        aFlatOrders.push({
                            orderId: order.MaintenanceOrder,
                            orderDesc: order.MaintenanceOrderDesc || "",
                            operationId: op.MaintenanceOrderOperation,
                            operationDesc: op.OperationDescription || "",
                            workCenter: op.WorkCenter || order.MainWorkCenter || "",
                            systemStatus: op.SystemStatusText || order.SystemStatusText || "",
                            reqStartDate: this.formatDate(op.OpErlstSchedldExecStrtDteTme) ? this.formatDate(op.OpErlstSchedldExecStrtDteTme) : null,
                            reqEndDate: this.formatDate(op.OpErlstSchedldExecEndDteTme) ? this.formatDate(op.OpErlstSchedldExecEndDteTme) : null,
                            assignedTo: op.OperationPersonResponsible || order.MaintOrdPersonResponsible || "",
                            activityType: op.ActivityType || order.MaintenanceActivityType || "",
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

                let oOrdersModel = new JSONModel({ orders: aFlatOrders });
                this.getOwnerComponent().setModel(oOrdersModel, "orders");

                const aTimeEntries = await this.fetchActiveTimeEntries();
                this.mergeTimeEntriesWithOrders(aTimeEntries);
                this._startGlobalTimerInterval();
                this._updatePanelVisibility();

            } catch (err) {
                MessageBox.error("Error loading orders and operations: " + err.message);
            } finally {
                this.getView().getModel("busy").setProperty("/busy", false);
            }
        },

        async loadOrdersAndTimeEntriesFiltered(sOrderIdFilter) {
            this.getView().getModel("busy").setProperty("/busy", true);

            try {
                let sFilter = "MaintOrderCreationDateTime gt datetimeoffset'2025-06-01T00:00:00Z' and MaintenanceOrderType eq 'EREF'";
                if (sOrderIdFilter && sOrderIdFilter.length > 0) {
                    sFilter += " and substringof('" + sOrderIdFilter + "', MaintenanceOrder)";
                }
                const sUrl = "/sap/opu/odata/sap/API_MAINTENANCEORDER;v=2/MaintenanceOrder?$filter=" +
                    encodeURIComponent(sFilter) + "&$expand=to_MaintenanceOrderOperation&$format=json";

                const response = await fetch(sUrl);
                if (!response.ok) {
                    throw new Error("Failed to fetch filtered orders");
                }
                const data = await response.json();
                const aOrdersRaw = data.d && data.d.results ? data.d.results : [];

                const aFlatOrders = [];

                aOrdersRaw.forEach(order => {
                    const aOperations = order.to_MaintenanceOrderOperation ? order.to_MaintenanceOrderOperation.results : [];
                    aOperations.forEach(op => {
                        aFlatOrders.push({
                            orderId: order.MaintenanceOrder,
                            orderDesc: order.MaintenanceOrderDesc || "",
                            operationId: op.MaintenanceOrderOperation,
                            operationDesc: op.OperationDescription || "",
                            workCenter: op.WorkCenter || order.MainWorkCenter || "",
                            systemStatus: op.SystemStatusText || order.SystemStatusText || "",
                            reqStartDate: this.formatDate(op.OpErlstSchedldExecStrtDteTme) ? this.formatDate(op.OpErlstSchedldExecStrtDteTme) : null,
                            reqEndDate: this.formatDate(op.OpErlstSchedldExecEndDteTme) ? this.formatDate(op.OpErlstSchedldExecEndDteTme) : null,
                            assignedTo: op.OperationPersonResponsible || order.MaintOrdPersonResponsible || "",
                            activityType: op.ActivityType || order.MaintenanceActivityType || "",
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

                let oOrdersModel = new JSONModel({ orders: aFlatOrders });
                this.getOwnerComponent().setModel(oOrdersModel, "orders");

                const aTimeEntries = await this.fetchActiveTimeEntries();
                this.mergeTimeEntriesWithOrders(aTimeEntries);
                this._startGlobalTimerInterval();
                this._updatePanelVisibility();

            } catch (err) {
                MessageBox.error("Error loading filtered orders and operations: " + err.message);
            } finally {
                this.getView().getModel("busy").setProperty("/busy", false);
            }
        },

        fetchActiveTimeEntries: function () {
            var that = this;
            return new Promise(function (resolve) {

                var sUserId = that.getCurrentUserId();
                var sFilter = `CreatedBy eq '${sUserId}'`;
                var sUrl = that.sHanaServiceUrl + "?$filter=" + encodeURIComponent(sFilter) + "&$format=json";

                fetch(sUrl, {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json"
                    }
                })
                    .then(function (response) {
                        return response.json();
                    })
                    .then(function (data) {
                        var aResults = data.value || (data.d && data.d.results) || [];
                        var aFiltered = aResults.filter(function (item) {
                            return item.Status === "InProcess";
                        });
                        resolve(aFiltered);
                    })
                    .catch(function () {
                        resolve([]);
                    });
            });
        },

        mergeTimeEntriesWithOrders: function (aTimeEntries) {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var aOrders = oOrdersModel.getProperty("/orders");

            aTimeEntries.forEach(function (oEntry) {
                var oOrder = aOrders.find(function (o) {
                    // FIX: Ensure strict matching handles potential leading zeros or string/int mismatch
                    // We compare them as Strings after removing leading zeros just to be safe
                    var orderIdA = parseInt(o.orderId, 10);
                    var orderIdB = parseInt(oEntry.OrderID, 10);
                    var opIdA = parseInt(o.operationId, 10);
                    var opIdB = parseInt(oEntry.OperationSO, 10);

                    return orderIdA === orderIdB && opIdA === opIdB;
                });

                if (oOrder) {
                    var sStartDate = oEntry.ExecStartDate;
                    var sStartTime = oEntry.ExecStartTime;
                    var sClockInTimeIso = null;

                    if (sStartDate && sStartTime) {
                        sClockInTimeIso = sStartDate + "T" + sStartTime;
                    }

                    oOrder.timerState = {
                        elapsedSeconds: 0,
                        baseElapsedSeconds: 0,
                        isRunning: true,
                        clockInTime: sClockInTimeIso,
                        timeEntryId: oEntry.ID
                    };
                }
            });

            oOrdersModel.refresh();
        },

        _startGlobalTimerInterval: function () {
            var that = this;
            if (this._timerInterval) {
                return;
            }
            this._timerInterval = setInterval(function () {
                var oOrdersModel = that.getOwnerComponent().getModel("orders");
                var aOrders = oOrdersModel.getProperty("/orders");
                var bIsAnyTimerRunning = false;
                var iNow = new Date().getTime();

                aOrders.forEach(function (oOrder, iIndex) {
                    if (oOrder.timerState.isRunning && oOrder.timerState.clockInTime) {
                        bIsAnyTimerRunning = true;
                        var sClockInTime = oOrder.timerState.clockInTime;
                        var iBaseSeconds = oOrder.timerState.baseElapsedSeconds || 0;
                        var iSessionSeconds = (iNow - new Date(sClockInTime).getTime()) / 1000;
                        var iTotalSeconds = Math.round(iBaseSeconds + iSessionSeconds);

                        oOrdersModel.setProperty("/orders/" + iIndex + "/timerState/elapsedSeconds", iTotalSeconds);
                    }
                });

                if (!bIsAnyTimerRunning) {
                    clearInterval(that._timerInterval);
                    that._timerInterval = null;
                }
            }, 1000);
        },

        _stopSpecificTimer: function (oContext) {
            var sPath = oContext.getPath();
            var oTimerState = oContext.getProperty("timerState");
            if (!oTimerState) return 0;
            var sClockInTime = oTimerState.clockInTime;
            var iBaseSeconds = oTimerState.baseElapsedSeconds || 0;
            var iTotalSeconds = oTimerState.elapsedSeconds;
            if (sClockInTime) {
                var iSessionSeconds = (new Date().getTime() - new Date(sClockInTime).getTime()) / 1000;
                iTotalSeconds = Math.round(iBaseSeconds + iSessionSeconds);
            }
            oTimerState.elapsedSeconds = iTotalSeconds;
            oTimerState.isRunning = false;
            oTimerState.clockInTime = null;
            oTimerState.baseElapsedSeconds = iTotalSeconds;
            oContext.getModel().setProperty(sPath + "/timerState", oTimerState);
            var oInProgressList = this.byId("inProgressList");
            if (oInProgressList) {
                oInProgressList.getBinding("items").refresh();
            }
            this._updatePanelVisibility();
            return iTotalSeconds;
        },

        _updatePanelVisibility: function () {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var oViewStateModel = this.getOwnerComponent().getModel("viewState");
            var aOrders = oOrdersModel.getProperty("/orders");

            if (!aOrders) {
                return;
            }

            var bIsVisible = aOrders.some(function (order) {
                return order.timerState.isRunning === true;
            });
            oViewStateModel.setProperty("/isProgressPanelVisible", bIsVisible);
        },

        onSearchOrders: function () {
            var that = this;
            var oSearchField = this.byId("orderIdSearch");
            var sQuery = oSearchField ? oSearchField.getValue().trim() : "";

            if (this._filterDebounceTimer) {
                clearTimeout(this._filterDebounceTimer);
            }

            this._filterDebounceTimer = setTimeout(function () {
                if (!sQuery || sQuery.length < 3) {
                    that.loadOrdersAndTimeEntries();
                } else {
                    that.loadOrdersAndTimeEntriesFiltered(sQuery);
                }
            }, 400);
        },

        onRefreshOrders: function () {
            MessageToast.show("Refreshing orders...");
            this.loadOrdersAndTimeEntries();
        },

        onSelectOrder: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext("orders");
            var sOrderId = oContext.getProperty("orderId");
            var sOperationId = oContext.getProperty("operationId");
            var oActiveTimerModel = this.getView().getModel("activeTimer");

            var sCurrentActiveId = oActiveTimerModel.getProperty("/activeOrderId");
            var sCurrentActiveOp = oActiveTimerModel.getProperty("/activeOperationId");

            if (oContext.getProperty("timerState/isRunning")) {
                return;
            }

            if (sCurrentActiveId === sOrderId && sCurrentActiveOp === sOperationId) {
                oActiveTimerModel.setProperty("/activeOrderId", null);
                oActiveTimerModel.setProperty("/activeOperationId", null);
            } else {
                oActiveTimerModel.setProperty("/activeOrderId", sOrderId);
                oActiveTimerModel.setProperty("/activeOperationId", sOperationId);
            }
        },

        _getCsrfToken: function () {
            var that = this;
            if (this._csrfToken) {
                return Promise.resolve(this._csrfToken);
            }

            return fetch(this.sHanaServiceUrl, {
                method: "GET",
                headers: {
                    "X-CSRF-Token": "Fetch"
                },
                credentials: "include"
            })
                .then(function (response) {
                    var token = response.headers.get("X-CSRF-Token");
                    if (!token) {
                        throw new Error("CSRF token not returned by backend");
                    }
                    that._csrfToken = token;
                    return token;
                });
        },

        onClockIn: function (oEvent) {
            var that = this;
            var oContext = oEvent.getSource().getBindingContext("orders");
            var sOrderId = oContext.getProperty("orderId");
            var sOperationId = oContext.getProperty("operationId");

            var now = new Date();
            var localIso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString();
            var datePart = localIso.slice(0, 10);
            var timePart = localIso.slice(11, 19);
            var sPunchInTimeIso = datePart + "T" + timePart;

            var oPayload = {
                UserID: "TEST",
                OrderID: sOrderId,
                OperationSO: sOperationId,
                ExecStartDate: datePart,
                ExecStartTime: timePart,
                Status: "InProcess"
            };

            this._getCsrfToken()
                .then(function (sToken) {
                    return fetch(that.sHanaServiceUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-CSRF-Token": sToken
                        },
                        credentials: "include",
                        body: JSON.stringify(oPayload)
                    });
                })
                .then(function (response) {
                    return response.json();
                })
                .then(function (data) {
                    var sTimeEntryId = data.ID || (data.d && data.d.ID);
                    var oTimerState = oContext.getProperty("timerState");
                    oTimerState.isRunning = true;
                    oTimerState.clockInTime = sPunchInTimeIso;
                    oTimerState.baseElapsedSeconds = 0;
                    oTimerState.elapsedSeconds = 0;
                    oTimerState.timeEntryId = sTimeEntryId;

                    oContext.getModel().setProperty(oContext.getPath() + "/timerState", oTimerState);
                    that._startGlobalTimerInterval();
                    that._updatePanelVisibility();

                    var oInProgressList = that.byId("inProgressList");
                    if (oInProgressList) {
                        oInProgressList.getBinding("items").refresh();
                    }

                    MessageToast.show("Clocked in successfully");
                })
                .catch(function (error) {
                    MessageBox.error("Failed to clock in: " + error.message);
                });
        },

        onClockOut: function (oEvent) {
            var that = this;
            var oContext = oEvent.getSource().getBindingContext("orders");
            var sOrderId = oContext.getProperty("orderId");
            var sOperationId = oContext.getProperty("operationId");

            // 1. Calculate time, but DO NOT stop the timer in the model yet
            var sClockOutTime = new Date();
            var sClockInTime = new Date(oContext.getProperty("timerState/clockInTime"));

            // Manual calculation instead of calling _stopSpecificTimer
            var iBaseSeconds = oContext.getProperty("timerState/baseElapsedSeconds") || 0;
            var iSessionSeconds = (sClockOutTime.getTime() - sClockInTime.getTime()) / 1000;
            var iFinalElapsedSeconds = Math.round(iBaseSeconds + iSessionSeconds);
            var fActualWorkHours = (iFinalElapsedSeconds / 3600).toFixed(2);

            var sUserId = that.getCurrentUserId();
            var sUrl = that.sHanaServiceUrl + "?$filter=CreatedBy eq '" + sUserId + "'&$format=json";

            fetch(sUrl, {
                method: "GET",
                headers: { "Content-Type": "application/json" }
            })
                .then(function (response) { return response.json(); })
                .then(function (data) {
                    var aResults = data.value || (data.d && data.d.results) || [];
                    var aFiltered = aResults.filter(function (item) {
                        return item.Status === "InProcess"
                            && item.OrderID === sOrderId
                            && item.OperationSO === sOperationId;
                    });

                    if (aFiltered.length === 0) {
                        MessageBox.error("No active time entry found for clock out.");
                        return;
                    }

                    var oTimeEntry = aFiltered[0];
                    var oDialogModel = that.getView().getModel("dialog");

                    // 2. Set data to dialog, including the Context Path so we can stop it later
                    oDialogModel.setData({
                        orderId: sOrderId,
                        operationId: sOperationId,
                        workStartDate: sClockInTime,
                        workFinishDate: sClockOutTime,
                        actualWork: fActualWorkHours,
                        elapsedSeconds: iFinalElapsedSeconds,
                        confirmationText: "",
                        isFinalConfirmation: false,
                        contextPath: oContext.getPath(), // <--- Important: Save the path
                        timeEntryId: oTimeEntry.ID
                    });

                    that.openSubmitDialog();
                })
                .catch(function (error) {
                    MessageBox.error("Failed to retrieve active time entries: " + error.message);
                });
        },

        updateTimeEntryOnServer: function (orderID, operationId, sPunchOutTime, sStatus) {
            var that = this;
            var sUserId = that.getCurrentUserId();
            var filter = "OrderID eq '" + orderID + "' and OperationSO eq '" + operationId + "' and UserID eq '" + sUserId + "' and " +
                "(Status eq 'InProcess' or Status eq 'Error') and CreatedBy eq '" + sUserId + "'";
            var sQueryUrl = that.sHanaServiceUrl + "?$filter=" + encodeURIComponent(filter) + "&$format=json";

            fetch(sQueryUrl, {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                },
                credentials: "include"
            })
                .then(function (response) {
                    if (!response.ok) throw new Error("Failed to fetch entries: " + response.status);
                    return response.json();
                })
                .then(function (data) {
                    var entries = data.value || [];
                    if (entries.length === 0) {
                        throw new Error("No matching entries with status InProcess or Error.");
                    }

                    var patchPromises = entries.map(function (entry) {
                        var sUserId = that.getCurrentUserId();
                        var sUrl = that.sHanaServiceUrl + "(ID='" + encodeURIComponent(entry.ID) + "')?$filter=CreatedBy eq '" + sUserId + "'";

                        var oPayload = {};
                        if (sPunchOutTime) {
                            var d = new Date(sPunchOutTime);
                            var localIso = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString();
                            oPayload.ExecFinDate = localIso.slice(0, 10);
                            oPayload.ExecFinTime = localIso.slice(11, 19);
                        }
                        if (sStatus) {
                            oPayload.Status = sStatus;
                        }

                        return fetch(sUrl, {
                            method: "GET",
                            headers: { "Accept": "application/json" },
                            credentials: "include"
                        })
                            .then(function (res) {
                                if (!res.ok) throw new Error("Failed to fetch ETag for ID " + entry.ID);
                                return res.headers.get("ETag");
                            })
                            .then(function (sETag) {
                                return that._getCsrfToken().then(function (sToken) {
                                    return fetch(sUrl, {
                                        method: "PATCH",
                                        headers: {
                                            "Content-Type": "application/json",
                                            "X-CSRF-Token": sToken,
                                            "If-Match": sETag
                                        },
                                        credentials: "include",
                                        body: JSON.stringify(oPayload)
                                    });
                                });
                            });
                    });

                    return Promise.all(patchPromises);
                })
                .then(function () {
                    MessageToast.show("Time entries updated successfully");
                    that.loadOrdersAndTimeEntries();
                })
                .catch(function (error) {
                    MessageBox.error("Failed to update time entries: " + error.message);
                });
        },

        openSubmitDialog: function () {
            var that = this;
            if (!this._oSubmitDialog) {
                Fragment.load({
                    name: "timetracker.view.fragment.SubmitDialog",
                    controller: this
                }).then(function (oDialog) {
                    that._oSubmitDialog = oDialog;
                    that.getView().addDependent(that._oSubmitDialog);
                    that._oSubmitDialog.open();
                });
            } else {
                this._oSubmitDialog.open();
            }
        },

        onCloseDialog: function () {
            this.fetchActiveTimeEntries();
            this._oSubmitDialog.close();
        },

        onSubmitConfirmation: function () {
            var oDialogModel = this.getView().getModel("dialog");
            var oData = oDialogModel.getData();

            if (!oData.workStartDate || !oData.workFinishDate || !oData.actualWork) {
                MessageBox.error("Please fill in all required time fields.");
                return;
            }

            MessageToast.show("Submitting to S/4HANA...");
            this.postConfirmationToBAPI(oData);
        },

        postConfirmationToBAPI: function (oData) {
            var that = this;
            var sUserId = that.getCurrentUserId();
            var sUrl = that.sHanaServiceUrl + "?$filter=CreatedBy eq '" + sUserId + "'&$format=json";


            fetch(sUrl, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
                credentials: "include"
            })
                .then(function (response) {
                    if (!response.ok) throw new Error("Failed to fetch time entries.");
                    return response.json();
                })
                .then(function (data) {
                    var entries = data.value || [];
                    var filteredEntries = entries.filter(function (entry) {
                        return entry.OrderID === oData.orderId
                            && entry.OperationSO === oData.operationId
                            && (entry.Status === "InProcess" || entry.Status === "Error");
                    });

                    if (filteredEntries.length === 0) {
                        throw new Error("No matching time entry found.");
                    }

                    var entry = filteredEntries[0];

                    function parseDateTime(dateStr, timeStr) {
                        return dateStr && timeStr ? new Date(dateStr + "T" + timeStr) : null;
                    }

                    var execStartDateTime = parseDateTime(entry.ExecStartDate, entry.ExecStartTime);
                    var execFinishDateTime = null;
                    if (oData.workFinishDate) {
                        execFinishDateTime = new Date(oData.workFinishDate);
                    } else if (entry.ExecFinDate && entry.ExecFinTime) {
                        execFinishDateTime = parseDateTime(entry.ExecFinDate, entry.ExecFinTime);
                    }

                    var actWorkHours = 0;
                    if (execStartDateTime && execFinishDateTime && execFinishDateTime > execStartDateTime) {
                        var elapsedMs = execFinishDateTime - execStartDateTime;
                        actWorkHours = elapsedMs / (1000 * 3600);
                        actWorkHours = parseFloat(actWorkHours.toFixed(2));
                    }

                    function formatDateForBAPI(date) {
                        if (!date) return "";
                        var localIso = new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString();
                        return localIso.slice(0, 10);
                    }
                    function formatTimeForBAPI(date) {
                        if (!date) return "";
                        var localIso = new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString();
                        return localIso.slice(11, 19);
                    }

                    var oPayload = {
                        ORDERID: entry.OrderID,
                        OPERATION: entry.OperationSO,
                        CONF_TEXT: oData.confirmationText && oData.confirmationText.trim() !== ""
                            ? oData.confirmationText
                            : "Confirmed",
                        ACT_WORK: actWorkHours,
                        UN_WORK: 0,
                        EXEC_START_DATE: entry.ExecStartDate,
                        EXEC_START_TIME: entry.ExecStartTime,
                        EXEC_FIN_DATE: formatDateForBAPI(execFinishDateTime),
                        EXEC_FIN_TIME: formatTimeForBAPI(execFinishDateTime)
                    };

                    var sBapiUrl = "/sap/bc/zfmcall/BAPI_ALM_CONF_CRATE?format=json";

                    return fetch(sBapiUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(oPayload)
                    });
                })
                .then(function (response) {
                    if (!response.ok) throw new Error("BAPI call failed.");
                    return response.json();
                })
                .then(function (bapiData) {
                    if (bapiData.RETURN && bapiData.RETURN.TYPE === "S") {
                        MessageToast.show("Confirmation posted successfully!");
                        if (oData.contextPath) {
                            var oOrdersModel = that.getOwnerComponent().getModel("orders");
                            var oContext = oOrdersModel.createBindingContext(oData.contextPath);
                            that._stopSpecificTimer(oContext);
                        }
                        that.updateTimeEntryOnServer(
                            oData.orderId,
                            oData.operationId,
                            oData.workFinishDate,
                            "Completed"
                        );
                        that.onCloseDialog();
                    } else {
                        var sErrorMsg = bapiData.RETURN ? bapiData.RETURN.MESSAGE : "Unknown error";
                        throw new Error(sErrorMsg);
                    }
                })
                .catch(function (error) {
                    MessageBox.error("Network Error: Could not submit. Entry saved to Drafts. " + error.message, {
                        onClose: function () {

                            if (oData.contextPath) {
                                var oOrdersModel = that.getOwnerComponent().getModel("orders");
                                var oContext = oOrdersModel.createBindingContext(oData.contextPath);
                                that._stopSpecificTimer(oContext); // Stop it here too
                            }
                            that.updateTimeEntryOnServer(
                                oData.orderId,
                                oData.operationId,
                                oData.workFinishDate,
                                "Error"
                            );
                            that.saveEntryToDrafts();
                            that.onCloseDialog();
                        }
                    });
                });
        },

        formatDateForBAPI: function (oDate) {
            var d = new Date(oDate);
            var year = d.getFullYear();
            var month = ("0" + (d.getMonth() + 1)).slice(-2);
            var day = ("0" + d.getDate()).slice(-2);
            return year + "-" + month + "-" + day;
        },

        saveEntryToDrafts: function () {
            var that = this;
            var sUserId = that.getCurrentUserId();
            var sUrl = that.sHanaServiceUrl + "?$filter=CreatedBy eq '" + sUserId + "'&$format=json";


            fetch(sUrl, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            })
                .then(function (response) {
                    return response.json();
                })
                .then(function (data) {
                    var aResults = data.value || (data.d && data.d.results) || [];
                    var aErrorEntries = aResults.filter(function (item) {
                        return item.Status === "Error";
                    });

                    aErrorEntries.forEach(function (item) {
                        try {
                            var startDateTime = new Date(item.ExecStartDate + "T" + item.ExecStartTime);
                            var endDateTime = new Date(item.ExecFinDate + "T" + item.ExecFinTime);
                            var diffSeconds = (endDateTime - startDateTime) / 1000;
                            var hours = Math.floor(diffSeconds / 3600);
                            var minutes = Math.floor((diffSeconds % 3600) / 60);
                            var seconds = Math.floor(diffSeconds % 60);

                            item.formattedTime =
                                (hours < 10 ? "0" + hours : hours) + ":" +
                                (minutes < 10 ? "0" + minutes : minutes) + ":" +
                                (seconds < 10 ? "0" + seconds : seconds);
                        } catch (e) {
                            item.formattedTime = "";
                        }
                    });

                    var oDraftsModel = that.getOwnerComponent().getModel("drafts");
                    oDraftsModel.setProperty("/entries", aErrorEntries);
                })
                .catch(function (error) {
                    MessageBox.error("Failed to load draft entries: " + error.message);
                });
        },

        onPostDraft: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();
            MessageToast.show("Retrying post for Order " + oDraft.orderID + "...");
            this.postConfirmationToBAPI(oDraft);
        },

        onDeleteDraft: function (oEvent) {
            var that = this;
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var aEntries = oDraftsModel.getProperty("/entries");

            MessageBox.confirm("Are you sure you want to delete this draft entry?", {
                onClose: function (sAction) {
                    if (sAction === MessageBox.Action.OK) {
                        var aNewEntries = aEntries.filter(function (entry) {
                            return entry.id !== oDraft.id;
                        });
                        oDraftsModel.setProperty("/entries", aNewEntries);
                        MessageToast.show("Draft deleted.");

                        var sUserId = that.getCurrentUserId();
                        var filter =
                            "OrderID eq '" + oDraft.orderId + "' and " +
                            "OperationSO eq '" + oDraft.operationId + "' and " +
                            "UserID eq '" + sUserId + "' and " +
                            "CreatedBy eq '" + sUserId + "' and " +
                            "(Status eq 'Error')";


                        var sQueryUrl = that.sHanaServiceUrl + "?$filter=" + encodeURIComponent(filter) + "&$format=json";

                        that._getCsrfToken().then(function (sToken) {
                            fetch(sQueryUrl, {
                                method: "GET",
                                headers: { "Accept": "application/json" },
                                credentials: "include"
                            })
                                .then(function (response) {
                                    if (!response.ok) throw new Error("Failed to fetch entry");
                                    return response.json();
                                })
                                .then(function (data) {
                                    if (!data.value || data.value.length === 0) {
                                        throw new Error("No matching entry found");
                                    }
                                    var sId = data.value[0].ID;
                                    if (sId) {
                                        var sUrl = that.sHanaServiceUrl + "(ID='" + encodeURIComponent(sId) + "')";
                                        fetch(sUrl, {
                                            method: "GET",
                                            headers: { "Accept": "application/json" },
                                            credentials: "include"
                                        })
                                            .then(function (res) {
                                                if (!res.ok) throw new Error("Failed to fetch ETag for deletion");
                                                return res.headers.get("ETag");
                                            })
                                            .then(function (sETag) {
                                                fetch(sUrl, {
                                                    method: "PATCH",
                                                    headers: {
                                                        "Content-Type": "application/json",
                                                        "X-CSRF-Token": sToken,
                                                        "If-Match": sETag
                                                    },
                                                    credentials: "include",
                                                    body: JSON.stringify({ Status: "Deleted" })
                                                })
                                                    .then(function (resp) {
                                                        if (!resp.ok) throw new Error("Failed to set Deleted status");
                                                        MessageToast.show("Backend entry marked as Deleted");
                                                    })
                                                    .catch(function (err) {
                                                        MessageBox.error("Error updating backend: " + err.message);
                                                    });
                                            });
                                    }
                                })
                                .catch(function (error) {
                                    MessageBox.error("Error fetching backend entry: " + error.message);
                                });
                        });
                    }
                }
            });
        }
    });
});